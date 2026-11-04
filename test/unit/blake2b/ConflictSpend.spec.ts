import { ChainIdentityError } from '../../../lib/blake2b/ChainIdentity';
import {
  resetUniqueCache,
  setConflictDepth,
  verifyProviderCoins,
} from '../../../lib/blake2b/ProviderCoins';
import {
  checkLockupReplay,
  setReplayForkHeight,
} from '../../../lib/blake2b/ReplayGuard';
import type { IChainClient } from '../../../lib/chain/ChainClient';

// A coin from before the fork is split by spending it on one chain first,
// then spending it again, differently, on the other. The second spend can
// never be valid on the first chain, so its outputs are unique.

const FORK = 200;
const TIP = 300;
const DER_ALL = `3044${'00'.repeat(68)}01`;

type FakeTx = { height?: number; coinbase?: boolean; parents?: string[] };

const NOT_FOUND = 'No such mempool or blockchain transaction';

// Spends recorded in recent blocks: height -> outpoints (txid, vout 0) spent there
type Spends = Record<number, string[]>;

let nodeId = 0;

const node = (
  symbol: string,
  txs: Record<string, FakeTx>,
  wallet: string[],
  unspent: string[],
  failLookup = false,
  spends: Spends = {},
) => {
  // Block hashes are cached by the guard, so make them unique per node
  const id = ++nodeId;
  return {
    getBlockhash: jest.fn(async (h: number) => `${id}-${h}`),
    getBlockVerbose: jest.fn(async (hash: string) => {
      const h = Number(hash.split('-')[1]);
      return {
        hash,
        tx: (spends[h] ?? []).map((prev, n) => ({
          txid: `spender-${h}-${n}`,
          vin: [{ txid: prev, vout: 0 }],
        })),
      };
    }),
    symbol,
    getBlockchainInfo: jest.fn(async () => ({ blocks: TIP })),
    listUnspent: jest.fn(async () =>
      wallet.map((txid) => ({ txid, vout: 0, amount: 1, confirmations: 1 })),
    ),
    getRawTransaction: jest.fn(async (txid: string) => {
      if (txs[txid] === undefined) throw new Error(NOT_FOUND);
      return '00';
    }),
    testMempoolAccept: jest.fn(async () => [
      { allowed: false, 'reject-reason': 'missing-inputs' },
    ]),
    getRawTransactionVerbose: jest.fn(async (txid: string) => {
      if (failLookup) throw new Error('Work queue depth exceeded');
      const t = txs[txid];
      if (t === undefined) throw new Error(NOT_FOUND);
      return {
        txid,
        confirmations: t.height === undefined ? 0 : TIP - t.height + 1,
        vin: t.coinbase
          ? [{ coinbase: '03' }]
          : (t.parents ?? []).map((p) => ({
              txid: p,
              vout: 0,
              scriptSig: { asm: '', hex: '' },
              txinwitness: [DER_ALL],
            })),
      };
    }),
    // Like RpcClient: a null result is rejected, not returned
    rpc: jest.fn(async (method: string, params: unknown[]) => {
      if (method === 'gettxout' && unspent.includes(params[0] as string)) {
        return { value: 1 };
      }
      throw 'no result in RPC response';
    }),
  } as unknown as IChainClient;
};

const OLD = { height: 150, coinbase: true };

describe('conflicting spend on the other chain', () => {
  // Verdicts are remembered between checks; fake txids repeat across tests
  beforeEach(() => resetUniqueCache());

  test('accepts a coin whose input the other chain spent differently', async () => {
    const btc = node(
      'BTC',
      { old: OLD, split: { height: 280, parents: ['old'] } },
      ['split'],
      ['split'],
    );
    // XBT has the shared coin, already spent there by its own transaction
    const xbt = node(
      'XBT',
      { old: OLD, xsplit: { height: 270, parents: ['old'] } },
      [],
      [],
    );

    await expect(
      verifyProviderCoins(btc, xbt, FORK, { isBlake2b: false, other: xbt }),
    ).resolves.toContain('all unique to this chain');
  });

  test('accepts descendants of a split coin', async () => {
    const btc = node(
      'BTC',
      {
        old: OLD,
        split: { height: 280, parents: ['old'] },
        child: { height: 290, parents: ['split'] },
      },
      ['child'],
      ['child'],
    );
    const xbt = node('XBT', { old: OLD }, [], []);

    await expect(
      verifyProviderCoins(btc, xbt, FORK, { isBlake2b: false, other: xbt }),
    ).resolves.toContain('all unique');
  });

  test('still refuses without the other chain (old behaviour)', async () => {
    const btc = node(
      'BTC',
      { old: OLD, split: { height: 280, parents: ['old'] } },
      ['split'],
      ['split'],
    );
    const xbt = node('XBT', { old: OLD }, [], []);

    await expect(
      verifyProviderCoins(btc, xbt, FORK, { isBlake2b: false }),
    ).rejects.toThrow(/before the fork/);
  });

  test('refuses when the input is still unspent on the other chain', async () => {
    const btc = node(
      'BTC',
      { old: OLD, deposit: { height: 280, parents: ['old'] } },
      ['deposit'],
      ['deposit'],
    );
    const xbt = node('XBT', { old: OLD }, [], ['old']);

    await expect(
      verifyProviderCoins(btc, xbt, FORK, { isBlake2b: false, other: xbt }),
    ).rejects.toThrow(/before the fork/);
  });

  test('refuses when the other chain has the transaction itself (replayed)', async () => {
    const btc = node(
      'BTC',
      { old: OLD, deposit: { height: 280, parents: ['old'] } },
      ['deposit'],
      ['deposit'],
    );
    // Same transaction on both chains: old is spent there, by deposit itself
    const xbt = node(
      'XBT',
      { old: OLD, deposit: { height: 275, parents: ['old'] } },
      [],
      [],
    );

    await expect(
      verifyProviderCoins(btc, xbt, FORK, { isBlake2b: false, other: xbt }),
    ).rejects.toThrow(ChainIdentityError);
  });

  test('refuses when the input has not reached the other chain yet', async () => {
    // mid is post-fork and replayable but not yet replayed: absent there,
    // so "not unspent" proves nothing
    const btc = node(
      'BTC',
      {
        old: OLD,
        mid: { height: 260, parents: ['old'] },
        deposit: { height: 280, parents: ['mid'] },
      },
      ['deposit'],
      ['deposit'],
    );
    const xbt = node('XBT', { old: OLD }, [], ['old']);

    await expect(
      verifyProviderCoins(btc, xbt, FORK, { isBlake2b: false, other: xbt }),
    ).rejects.toThrow(/before the fork/);
  });

  test('fails closed when the other chain cannot answer', async () => {
    const btc = node(
      'BTC',
      { old: OLD, split: { height: 280, parents: ['old'] } },
      ['split'],
      ['split'],
    );
    const xbt = node('XBT', { old: OLD }, [], [], true);

    await expect(
      verifyProviderCoins(btc, xbt, FORK, { isBlake2b: false, other: xbt }),
    ).rejects.toThrow(/conflicting spend/);
  });

  test('D18 accepts a user lockup built from a split coin', async () => {
    setReplayForkHeight(FORK);
    const btc = node(
      'BTC',
      { old: OLD, lockup: { height: 280, parents: ['old'] } },
      [],
      ['lockup'],
    );
    const xbt = node(
      'XBT',
      { old: OLD, xsplit: { height: 270, parents: ['old'] } },
      [],
      [],
    );

    await expect(
      checkLockupReplay('lockup', '00', xbt, btc),
    ).resolves.toBeUndefined();
  });

  test('D18 still refuses a replayable user lockup', async () => {
    setReplayForkHeight(FORK);
    const btc = node(
      'BTC',
      { old: OLD, lockup: { height: 280, parents: ['old'] } },
      [],
      ['lockup'],
    );
    const xbt = node('XBT', { old: OLD }, [], ['old']);

    await expect(checkLockupReplay('lockup', '00', xbt, btc)).resolves.toMatch(
      /replayable/,
    );
  });

  describe('reorg depth of the conflicting spend', () => {
    const split = () =>
      node(
        'BTC',
        { old: OLD, split: { height: 280, parents: ['old'] } },
        ['split'],
        ['split'],
      );
    const xbtSpentAt = (height: number) =>
      node(
        'XBT',
        { old: OLD, xsplit: { height, parents: ['old'] } },
        [],
        [],
        false,
        { [height]: ['old'] },
      );

    afterEach(() => setConflictDepth(6));

    test('refuses a split whose conflicting spend is shallower than the depth', async () => {
      // Spent in the tip block: 1 deep, needs 6
      const xbt = xbtSpentAt(TIP);
      await expect(
        verifyProviderCoins(split(), xbt, FORK, {
          isBlake2b: false,
          other: xbt,
        }),
      ).rejects.toThrow(/only 1 block\(s\) deep; needs 6/);
    });

    test('accepts the same split once the spend is deep enough', async () => {
      // Spent 6 blocks below the tip: depth 6
      const xbt = xbtSpentAt(TIP - 5);
      await expect(
        verifyProviderCoins(split(), xbt, FORK, {
          isBlake2b: false,
          other: xbt,
        }),
      ).resolves.toContain('all unique');
    });

    test('a spend just short of the depth is still refused', async () => {
      const xbt = xbtSpentAt(TIP - 4);
      await expect(
        verifyProviderCoins(split(), xbt, FORK, {
          isBlake2b: false,
          other: xbt,
        }),
      ).rejects.toThrow(/only 5 block\(s\) deep/);
    });

    test('the depth follows setConflictDepth (mainnet raises it)', async () => {
      setConflictDepth(100);
      const xbt = xbtSpentAt(TIP - 50);
      await expect(
        verifyProviderCoins(split(), xbt, FORK, {
          isBlake2b: false,
          other: xbt,
        }),
      ).rejects.toThrow(/only 51 block\(s\) deep; needs 100/);
    });

    test('a per-call minConflictDepth overrides the default', async () => {
      const xbt = xbtSpentAt(TIP);
      await expect(
        verifyProviderCoins(split(), xbt, FORK, {
          isBlake2b: false,
          other: xbt,
          minConflictDepth: 1,
        }),
      ).resolves.toContain('all unique');
    });

    test('rejects a nonsensical depth', () => {
      expect(() => setConflictDepth(0)).toThrow(ChainIdentityError);
    });

    test('D18 refuses a lockup from a split that is still too shallow', async () => {
      setReplayForkHeight(FORK);
      const btc = node(
        'BTC',
        { old: OLD, lockup: { height: 280, parents: ['old'] } },
        [],
        ['lockup'],
      );
      const xbt = xbtSpentAt(TIP - 1);
      await expect(
        checkLockupReplay('lockup', '00', xbt, btc),
      ).resolves.toMatch(/only 2 block\(s\) deep/);
    });
  });
});
