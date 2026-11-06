import { ChainIdentityError } from '../../../lib/blake2b/ChainIdentity';
import {
  fetchTransaction,
  isNotHere,
  knownTransaction,
  localCopy,
  rememberTransaction,
  resetKnownTransactions,
  txidOfHex,
} from '../../../lib/blake2b/PrunedHistory';
import type { IChainClient } from '../../../lib/chain/ChainClient';

// The genesis coinbase (legacy serialization) and a three-input Taproot
// spend from the SHA256 regtest chain (segwit serialization), both checked
// against their blocks' merkle roots.
const GENESIS_TX =
  '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000';
const GENESIS_TXID =
  '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b';
const SEGWIT_TX =
  '020000000001035fa5f26110db753e624b9a61b3139302356f3e5ebd71cd024d33e9c85a07279c0000000000fefffffffa8793cff93a06d4bcbdaff1b3407509a39b13615a77352bdf40930e972085c60000000000feffffff4da9729af7be8581883a5b1ea41b795d38f99c783dc061a549e7e51fb1d36e550000000000feffffff027e0a0300000000001976a914ead38539f2070c0faa99df6366434792452b518b88ac7b83010000000000225120fa20265bd8502042e5d22a2394903ccdece69bc7197c05e81c5519af42da6fcf0140b26cb92b7c205fc148265f81fa6f5174576adccfd99d6090db23f8009b0664f083c6b44be2fa35794d8d84184cc56301ea28fedfc742492ba5beb231eb05b9cd0140f46ce64bb0bd62fb59f91e4b033ca5a9c4fa3be05c6c2d91171ba0efce63b8679c3d576dbd28bf550418f4c770d4ca138b71a36ac43c9bdf6a513b10ebe1aeab0140b659c0ab7e5e1595b143b461ba337a11cad59c026384ec8bc641c18a42b98dad75ee6f377d66ee824cfcafcbad1122ba632c4b1fb77819a0759ee8b06e0164dc47050000';
const SEGWIT_TXID =
  'c271addd4f5e23c2c60942d82763b878e5aca1861b5556a68627549e3cdccbec';

const NO_INDEX =
  'No such mempool transaction. Use -txindex or provide a block hash to enable blockchain transaction queries. Use gettransaction for wallet transactions.';

const TIP = 500;
const hashAt = (height: number) => `block${height}`;

type Node = {
  mempool?: Record<string, object>;
  wallet?: Record<
    string,
    { hex: string; blockhash?: string; confirmations?: number }
  >;
  // txid -> height of the block holding it
  blocks?: Record<string, number>;
  // block heights the node has pruned
  pruned?: number[];
  // heights a peer can serve (getblockfrompeer)
  peerHas?: number[];
  // txid:vout -> height, for outputs still unspent
  unspent?: Record<string, number>;
  // blockhash -> undo data for getblock 3
  undo?: Record<
    string,
    { txid: string; vin: { prevout?: { height: number } }[] }[]
  >;
  hexOf?: Record<string, string>;
  // return this hex instead of the real one (a lying proxy)
  forge?: string;
};

const fakeNode = (symbol: string, n: Node) => {
  const fetched = new Set<number>();
  const calls: string[] = [];
  const hexOf = n.hexOf ?? {};
  const raw = (txid: string, height?: number) => ({
    txid,
    hex: n.forge ?? hexOf[txid],
    vin: [],
    vout: [{ n: 0 }],
    confirmations: height === undefined ? undefined : TIP - height + 1,
    blockhash: height === undefined ? undefined : hashAt(height),
  });
  const client = {
    symbol,
    calls,
    getBlockchainInfo: jest.fn(async () => ({ blocks: TIP })),
    getBlockhash: jest.fn(async (h: number) => hashAt(h)),
    getRawTransactionVerbose: jest.fn(async (txid: string) => {
      calls.push(`node ${txid}`);
      if (n.mempool?.[txid] !== undefined) return n.mempool[txid];
      throw new Error(NO_INDEX);
    }),
    getWalletTransaction: jest.fn(async (txid: string) => {
      const w = n.wallet?.[txid];
      if (w === undefined)
        throw new Error('Invalid or non-wallet transaction id');
      return w;
    }),
    rpc: jest.fn(async (method: string, params: unknown[] = []) => {
      calls.push(method);
      switch (method) {
        case 'getrawtransaction': {
          const [txid, , blockhash] = params as [string, number, string];
          const height = Number((blockhash as string).replace('block', ''));
          if (n.pruned?.includes(height) && !fetched.has(height)) {
            throw new Error('Block not available (pruned data)');
          }
          if (n.blocks?.[txid] !== height) {
            throw new Error('No such transaction found in the provided block');
          }
          return raw(txid, height);
        }
        case 'getpeerinfo':
          return [{ id: 7, servicesnames: ['NETWORK', 'WITNESS'] }];
        case 'getblockfrompeer': {
          const height = Number((params[0] as string).replace('block', ''));
          if (!n.peerHas?.includes(height))
            throw new Error('Peer does not have block');
          fetched.add(height);
          return {};
        }
        case 'getblock': {
          const [hash, verbosity] = params as [string, number];
          if (verbosity === 3) {
            const tx = n.undo?.[hash];
            if (tx === undefined)
              throw new Error('Block not available (pruned data)');
            return { tx };
          }
          const height = Number(hash.replace('block', ''));
          if (n.pruned?.includes(height) && !fetched.has(height)) {
            throw new Error('Block not available (pruned data)');
          }
          return '00';
        }
        case 'gettxout': {
          const [txid, vout] = params as [string, number];
          const h = n.unspent?.[`${txid}:${vout}`];
          if (h === undefined) throw 'no result in RPC response';
          return { confirmations: TIP - h + 1 };
        }
        case 'decoderawtransaction': {
          const hex = params[0] as string;
          return { txid: txidOfHex(hex), vin: [], vout: [{ n: 0 }], hex };
        }
        default:
          throw new Error(`unexpected ${method}`);
      }
    }),
  };
  return client as unknown as IChainClient & { calls: string[] };
};

describe('PrunedHistory (D38)', () => {
  beforeEach(() => resetKnownTransactions());

  describe('txidOfHex', () => {
    test('a legacy transaction', () => {
      expect(txidOfHex(GENESIS_TX)).toEqual(GENESIS_TXID);
    });

    test('a segwit transaction hashes without its witness', () => {
      expect(txidOfHex(SEGWIT_TX)).toEqual(SEGWIT_TXID);
    });

    test('refuses a truncated transaction', () => {
      expect(() => txidOfHex(SEGWIT_TX.slice(0, -10))).toThrow();
    });
  });

  test('isNotHere tells a missing transaction from a broken node', () => {
    expect(isNotHere(new Error(NO_INDEX))).toBe(true);
    expect(isNotHere('no result in RPC response')).toBe(true);
    expect(isNotHere(new Error('Block not available (pruned data)'))).toBe(
      true,
    );
    expect(isNotHere(new Error('Work queue depth exceeded'))).toBe(false);
    expect(isNotHere(new Error('connect ECONNREFUSED'))).toBe(false);
  });

  test('rememberTransaction keys by the computed txid and keeps a known block', () => {
    expect(rememberTransaction('SHA256', SEGWIT_TX, hashAt(450))).toEqual(
      SEGWIT_TXID,
    );
    rememberTransaction('SHA256', SEGWIT_TX);
    expect(knownTransaction('SHA256', SEGWIT_TXID)?.blockhash).toEqual(
      hashAt(450),
    );
    expect(knownTransaction('BTC', SEGWIT_TXID)).toBeUndefined();
  });

  describe('fetchTransaction', () => {
    test('the node answers first (mempool or txindex): no fallbacks', async () => {
      const node = fakeNode('SHA256', {
        mempool: { [SEGWIT_TXID]: { txid: SEGWIT_TXID } },
      });
      await expect(fetchTransaction(node, SEGWIT_TXID)).resolves.toEqual({
        txid: SEGWIT_TXID,
      });
      expect(node.calls).toEqual([`node ${SEGWIT_TXID}`]);
    });

    test('a broken node is not treated as "not here"', async () => {
      const node = fakeNode('SHA256', {});
      (node.getRawTransactionVerbose as jest.Mock).mockRejectedValueOnce(
        new Error('Work queue depth exceeded'),
      );
      await expect(fetchTransaction(node, SEGWIT_TXID)).rejects.toThrow(
        'Work queue depth exceeded',
      );
    });

    test('a wallet transaction, read from its block', async () => {
      const node = fakeNode('SHA256', {
        wallet: {
          [SEGWIT_TXID]: {
            hex: SEGWIT_TX,
            blockhash: hashAt(260),
            confirmations: TIP - 260 + 1,
          },
        },
        blocks: { [SEGWIT_TXID]: 260 },
        hexOf: { [SEGWIT_TXID]: SEGWIT_TX },
      });
      const tx = await fetchTransaction(node, SEGWIT_TXID);
      expect(tx.blockhash).toEqual(hashAt(260));
      expect(tx.confirmations).toEqual(TIP - 260 + 1);
    });

    test('a seen transaction is placed through an output that is still unspent', async () => {
      rememberTransaction('SHA256', SEGWIT_TX);
      const node = fakeNode('SHA256', {
        unspent: { [`${SEGWIT_TXID}:0`]: 480 },
        blocks: { [SEGWIT_TXID]: 480 },
        hexOf: { [SEGWIT_TXID]: SEGWIT_TX },
      });
      const tx = await fetchTransaction(node, SEGWIT_TXID);
      expect(tx.confirmations).toEqual(TIP - 480 + 1);
      // and its block is kept for next time
      expect(knownTransaction('SHA256', SEGWIT_TXID)?.blockhash).toEqual(
        hashAt(480),
      );
    });

    test('the hinted output of an unseen transaction places it', async () => {
      const node = fakeNode('SHA256', {
        unspent: { [`${SEGWIT_TXID}:1`]: 300 },
        blocks: { [SEGWIT_TXID]: 300 },
        hexOf: { [SEGWIT_TXID]: SEGWIT_TX },
      });
      const tx = await fetchTransaction(node, SEGWIT_TXID, { vout: 1 });
      expect(tx.blockhash).toEqual(hashAt(300));
    });

    test("the spender's undo data places a spent parent, fetched from a peer when pruned", async () => {
      const node = fakeNode('SHA256', {
        undo: {
          [hashAt(490)]: [
            {
              txid: 'child',
              vin: [{ prevout: { height: 210 } }, { prevout: { height: 220 } }],
            },
          ],
        },
        blocks: { [SEGWIT_TXID]: 220 },
        pruned: [220],
        peerHas: [220],
        hexOf: { [SEGWIT_TXID]: SEGWIT_TX },
      });
      const tx = await fetchTransaction(node, SEGWIT_TXID, {
        child: { txid: 'child', blockhash: hashAt(490), input: 1 },
      });
      expect(tx.blockhash).toEqual(hashAt(220));
      expect(node.calls).toContain('getblockfrompeer');
    });

    test('shared history comes from the oracle, restated against this chain', async () => {
      const node = fakeNode('SHA256', {});
      const oracle = fakeNode('BTC', {});
      (oracle.getBlockchainInfo as jest.Mock).mockResolvedValue({
        blocks: 400,
      });
      (oracle.getRawTransactionVerbose as jest.Mock).mockResolvedValue({
        txid: GENESIS_TXID,
        confirmations: 400 - 150 + 1,
        blockhash: 'btc-block-150',
      });
      const tx = await fetchTransaction(node, GENESIS_TXID, { oracle });
      // Height 150 on both chains, so TIP - 150 + 1 confirmations here
      expect(tx.confirmations).toEqual(TIP - 150 + 1);
      expect(tx.blockhash).toBeUndefined();
    });

    test('this chain is asked before the oracle', async () => {
      const node = fakeNode('SHA256', {
        wallet: {
          [SEGWIT_TXID]: {
            hex: SEGWIT_TX,
            blockhash: hashAt(260),
            confirmations: TIP - 260 + 1,
          },
        },
        blocks: { [SEGWIT_TXID]: 260 },
        hexOf: { [SEGWIT_TXID]: SEGWIT_TX },
      });
      const oracle = fakeNode('BTC', {});
      await fetchTransaction(node, SEGWIT_TXID, { oracle });
      expect(oracle.getRawTransactionVerbose).not.toHaveBeenCalled();
    });

    test('fails closed when nothing has it', async () => {
      const node = fakeNode('SHA256', {});
      const oracle = fakeNode('BTC', {});
      const fetching = fetchTransaction(node, SEGWIT_TXID, { oracle, vout: 0 });
      await expect(fetching).rejects.toThrow(ChainIdentityError);
      await expect(
        fetchTransaction(node, SEGWIT_TXID, { oracle }),
      ).rejects.toThrow(
        /no txindex and SwapSha found no copy .*not on the BTC chain/,
      );
    });

    test('a pruned block no peer has: not found, so fails closed', async () => {
      const node = fakeNode('SHA256', {
        unspent: { [`${SEGWIT_TXID}:0`]: 230 },
        blocks: { [SEGWIT_TXID]: 230 },
        pruned: [230],
        hexOf: { [SEGWIT_TXID]: SEGWIT_TX },
      });
      await expect(
        fetchTransaction(node, SEGWIT_TXID, { vout: 0 }),
      ).rejects.toThrow(ChainIdentityError);
    }, 60_000);

    test('refuses a block copy that does not hash to the txid asked for', async () => {
      const node = fakeNode('SHA256', {
        unspent: { [`${SEGWIT_TXID}:0`]: 300 },
        blocks: { [SEGWIT_TXID]: 300 },
        forge: GENESIS_TX,
      });
      await expect(
        fetchTransaction(node, SEGWIT_TXID, { vout: 0 }),
      ).rejects.toThrow(/does not hash to it/);
    });
  });

  describe('localCopy (ChainClient fallback, no oracle)', () => {
    test('a seen transaction with no block found comes back unconfirmed', async () => {
      rememberTransaction('SHA256', SEGWIT_TX);
      const node = fakeNode('SHA256', {});
      const copy = await localCopy(node, SEGWIT_TXID);
      expect(copy?.hex).toEqual(SEGWIT_TX);
      expect(copy?.confirmations).toBeUndefined();
    });

    test('nothing seen, nothing in the wallet: undefined', async () => {
      await expect(
        localCopy(fakeNode('SHA256', {}), SEGWIT_TXID),
      ).resolves.toBeUndefined();
    });
  });
});
