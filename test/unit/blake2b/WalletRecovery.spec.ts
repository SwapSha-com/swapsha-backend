import {
  describeRecovery,
  recoverSeedWallet,
} from '../../../lib/blake2b/NodeWallets';

// SwapSha D40, second amendment (Nov 10): a lost seed wallet's coins found
// again from the fork block, by rescan on an archival node and by block
// filters plus blocks fetched back from peers on a pruned one

type Call = { wallet: boolean; method: string; params: unknown[] };

const fakeNode = (state: {
  pruned: boolean;
  tip?: number;
  // hash -> height of the blocks the filters match
  relevant?: Record<string, number>;
  // blocks the node no longer stores
  prunedBlocks?: Set<string>;
  // peer id -> whether it gives blocks back
  peers?: Record<number, boolean>;
  scanFails?: string;
}) => {
  const calls: Call[] = [];
  const stored = new Set(Object.keys(state.relevant ?? {}));
  for (const hash of state.prunedBlocks ?? []) stored.delete(hash);

  const rpc = async (method: string, params: unknown[] = []) => {
    calls.push({ wallet: false, method, params });
    switch (method) {
      case 'getblockchaininfo':
        return { pruned: state.pruned, blocks: state.tip ?? 1_000 };
      case 'scanblocks':
        if (state.scanFails) throw new Error(state.scanFails);
        return {
          relevant_blocks: Object.keys(state.relevant ?? {}),
          completed: true,
        };
      case 'getblockheader':
        return { height: state.relevant![params[0] as string] };
      case 'getblock':
        if (!stored.has(params[0] as string)) {
          throw new Error('Block not available (pruned data)');
        }
        return '00';
      case 'getpeerinfo':
        return Object.keys(state.peers ?? {}).map((id) => ({
          id: Number(id),
          servicesnames: ['NETWORK', 'WITNESS'],
        }));
      case 'getblockfrompeer':
        if (state.peers?.[params[1] as number]) {
          stored.add(params[0] as string);
        }
        return {};
      default:
        throw new Error(`unexpected ${method}`);
    }
  };

  const walletRpc = async (method: string, params: unknown[] = []) => {
    calls.push({ wallet: true, method, params });
    switch (method) {
      case 'rescanblockchain':
        return { start_height: params[0], stop_height: params[1] };
      case 'listdescriptors':
        return {
          descriptors: [
            { desc: 'wpkh(tpub/0/*)#aaaa', active: true, range: [0, 999] },
            {
              desc: 'tr(tpub/1/*)#bbbb',
              active: true,
              internal: true,
              range: [0, 1_499],
            },
          ],
        };
      case 'getbalances':
        return { mine: { trusted: 0.0123 } };
      default:
        throw new Error(`unexpected wallet ${method}`);
    }
  };

  return {
    node: { symbol: 'SHA256', rpc, walletRpc } as any,
    calls,
  };
};

const noSleep = async () => {};

describe('recoverSeedWallet', () => {
  test('archival node: one rescan from the fork block', async () => {
    const { node, calls } = fakeNode({ pruned: false, tip: 160_500 });

    await expect(
      recoverSeedWallet(node, { wallet: 'swapsha', fromHeight: 150_308 }),
    ).resolves.toEqual({
      wallet: 'swapsha',
      mode: 'rescan',
      fromHeight: 150_308,
      blocks: 10_193,
      fetched: 0,
      balance: 0.0123,
    });
    expect(
      calls.filter((c) => c.method === 'rescanblockchain').map((c) => c.params),
    ).toEqual([[150_308]]);
    expect(calls.some((c) => c.method === 'scanblocks')).toBe(false);
  });

  test('pruned node: filters, fetch the pruned blocks, rescan each in height order', async () => {
    const { node, calls } = fakeNode({
      pruned: true,
      relevant: { c: 300, a: 205, b: 250 },
      prunedBlocks: new Set(['a', 'b']),
      peers: { 7: false, 9: true },
    });

    await expect(
      recoverSeedWallet(node, {
        wallet: 'swapsha',
        fromHeight: 200,
        sleep: noSleep,
        waitMs: 3_000,
      }),
    ).resolves.toEqual({
      wallet: 'swapsha',
      mode: 'filters',
      fromHeight: 200,
      blocks: 3,
      fetched: 2,
      balance: 0.0123,
    });

    // The wallet's public descriptors, each range at least 1,000 keys
    const scan = calls.find((c) => c.method === 'scanblocks')!;
    expect(scan.params).toEqual([
      'start',
      [
        { desc: 'wpkh(tpub/0/*)#aaaa', range: [0, 999] },
        { desc: 'tr(tpub/1/*)#bbbb', range: [0, 1_499] },
      ],
      200,
    ]);

    // Peer 7 gave nothing; peer 9 gave both blocks back
    expect(
      calls.filter((c) => c.method === 'getblockfrompeer').map((c) => c.params),
    ).toEqual([
      ['a', 7],
      ['a', 9],
      ['b', 7],
      ['b', 9],
    ]);
    expect(
      calls.filter((c) => c.method === 'rescanblockchain').map((c) => c.params),
    ).toEqual([
      [205, 205],
      [250, 250],
      [300, 300],
    ]);
  });

  test('pruned node: fails when no peer gives a pruned block back', async () => {
    const { node, calls } = fakeNode({
      pruned: true,
      relevant: { a: 205 },
      prunedBlocks: new Set(['a']),
      peers: { 7: false },
    });

    await expect(
      recoverSeedWallet(node, {
        wallet: 'swapsha',
        fromHeight: 200,
        sleep: noSleep,
        waitMs: 2_000,
      }),
    ).rejects.toThrow('no peer gave block a back');
    expect(calls.some((c) => c.method === 'rescanblockchain')).toBe(false);
  });

  test('pruned node without block filters says what it needs', async () => {
    const { node } = fakeNode({
      pruned: true,
      scanFails: 'Index is not enabled for filtertype basic',
    });

    await expect(
      recoverSeedWallet(node, { wallet: 'swapsha', fromHeight: 200 }),
    ).rejects.toThrow('a pruned node needs blockfilterindex=1');
  });

  test('describes what it did', () => {
    expect(
      describeRecovery('SHA256', {
        wallet: 'swapsha',
        mode: 'filters',
        fromHeight: 961_640,
        blocks: 3,
        fetched: 2,
        balance: 0.0123,
      }),
    ).toEqual(
      'SHA256 node wallet "swapsha" recovered from block 961640 (D40): 3 block(s) with its coins in the block filters, 2 fetched back from peers; confirmed balance 0.0123',
    );
  });
});
