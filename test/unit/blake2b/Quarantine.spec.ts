import {
  quarantineSharedCoins,
  resetUniqueCache,
} from '../../../lib/blake2b/ProviderCoins';
import type { IChainClient } from '../../../lib/chain/ChainClient';

// D26 at lockup time: coins that arrived while the backend ran are checked
// right before each server lockup, and shared ones are locked in the wallet.

const FORK = 200;
const TIP = 300;
const DER_ALL = `3044${'00'.repeat(68)}01`;

type FakeTx = { height?: number; coinbase?: boolean; parents?: string[] };

const wallet = (
  txs: Record<string, FakeTx>,
  utxos: string[],
  opts: {
    failLookup?: boolean;
    noPersistentLock?: boolean;
    failLock?: boolean;
  } = {},
) => {
  const locks: unknown[][] = [];
  const client = {
    symbol: 'SHA256',
    getBlockchainInfo: jest.fn(async () => ({ blocks: TIP })),
    listUnspent: jest.fn(async () =>
      utxos.map((txid) => ({ txid, vout: 0, amount: 0.5, confirmations: 1 })),
    ),
    getRawTransactionVerbose: jest.fn(async (txid: string) => {
      if (opts.failLookup) throw new Error('Work queue depth exceeded');
      const t = txs[txid];
      if (t === undefined) {
        throw new Error('No such mempool or blockchain transaction');
      }
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
    // Like a node with several wallets loaded: wallet methods are refused on
    // the node path and only work on /wallet/<name>
    rpc: jest.fn(async (method: string) => {
      if (method === 'lockunspent') {
        throw new Error(
          'Multiple wallets are loaded. Please select which wallet to use by requesting the RPC through the /wallet/<walletname> URI path.',
        );
      }
      throw 'no result in RPC response';
    }),
    walletRpc: jest.fn(async (method: string, params: unknown[]) => {
      if (method === 'lockunspent') {
        if (opts.failLock) throw new Error('Wallet is locked');
        if (opts.noPersistentLock && params.length === 3) {
          throw new Error('too many arguments');
        }
        locks.push(params);
        return true;
      }
      throw new Error(`unexpected wallet RPC ${method}`);
    }),
  } as unknown as IChainClient;
  return { client, locks };
};

const other = (elsewhere: string[] = []) =>
  ({
    symbol: 'BTC',
    getRawTransactionVerbose: jest.fn(async () => {
      throw new Error('No such mempool or blockchain transaction');
    }),
    rpc: jest.fn(async (method: string, params: unknown[]) => {
      if (method === 'gettxout' && elsewhere.includes(params[0] as string)) {
        return { value: 1 };
      }
      throw 'no result in RPC response';
    }),
  }) as unknown as IChainClient;

const TXS: Record<string, FakeTx> = {
  old: { height: 150, coinbase: true },
  fresh: { height: 250, coinbase: true },
  change: { height: 260, parents: ['fresh'] },
  // Arrived while running: post-fork, but spends only a pre-fork coin
  deposit: { height: 290, parents: ['old'] },
};

describe('quarantineSharedCoins (D26 at lockup time)', () => {
  beforeEach(() => resetUniqueCache());

  test('leaves unique coins alone', async () => {
    const { client, locks } = wallet(TXS, ['fresh', 'change']);
    const result = await quarantineSharedCoins(client, other(), FORK, {
      isBlake2b: false,
    });
    expect(result.quarantined).toEqual([]);
    expect(locks).toEqual([]);
  });

  test('locks a shared deposit that arrived after startup, persistently', async () => {
    const { client, locks } = wallet(TXS, ['change', 'deposit']);
    const result = await quarantineSharedCoins(client, other(), FORK, {
      isBlake2b: false,
    });
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0].outpoint).toBe('deposit:0');
    expect(result.quarantined[0].reason).toMatch(/before the fork/);
    expect(locks).toEqual([[false, [{ txid: 'deposit', vout: 0 }], true]]);
  });

  test('locks a coin the other chain already has', async () => {
    const { client, locks } = wallet(TXS, ['fresh']);
    const result = await quarantineSharedCoins(client, other(['fresh']), FORK, {
      isBlake2b: false,
    });
    expect(result.quarantined[0].reason).toMatch(/also exists on the BTC/);
    expect(locks).toHaveLength(1);
  });

  test('falls back to an in-memory lock on nodes without the persistent flag', async () => {
    const { client, locks } = wallet(TXS, ['deposit'], {
      noPersistentLock: true,
    });
    await quarantineSharedCoins(client, other(), FORK, { isBlake2b: false });
    expect(locks).toEqual([[false, [{ txid: 'deposit', vout: 0 }]]]);
  });

  test('remembers unique verdicts, so the next lockup walks only new coins', async () => {
    const { client } = wallet(TXS, ['fresh', 'change']);
    const first = await quarantineSharedCoins(client, other(), FORK, {
      isBlake2b: false,
    });
    const second = await quarantineSharedCoins(client, other(), FORK, {
      isBlake2b: false,
    });
    expect(first.checked).toBeGreaterThan(0);
    expect(second.checked).toBe(0);
  });

  test('never remembers shared verdicts', async () => {
    const { client } = wallet(TXS, ['deposit']);
    await quarantineSharedCoins(client, other(), FORK, { isBlake2b: false });
    const again = await quarantineSharedCoins(client, other(), FORK, {
      isBlake2b: false,
    });
    expect(again.quarantined).toHaveLength(1);
    expect(again.checked).toBeGreaterThan(0);
  });

  test('fails closed when a coin cannot be checked', async () => {
    const { client, locks } = wallet(TXS, ['change'], { failLookup: true });
    await expect(
      quarantineSharedCoins(client, other(), FORK, { isBlake2b: false }),
    ).rejects.toThrow(/txindex/);
    expect(locks).toEqual([]);
  });

  test('sends lockunspent to the wallet path, not the node path', async () => {
    const { client, locks } = wallet(TXS, ['deposit']);
    await quarantineSharedCoins(client, other(), FORK, { isBlake2b: false });
    expect(locks).toHaveLength(1);
    const nodeCalls = (
      client as unknown as { rpc: jest.Mock }
    ).rpc.mock.calls.map((c) => c[0]);
    expect(nodeCalls).not.toContain('lockunspent');
  });

  test('fails closed with both errors when the coin cannot be locked', async () => {
    const { client } = wallet(TXS, ['deposit'], { failLock: true });
    await expect(
      quarantineSharedCoins(client, other(), FORK, { isBlake2b: false }),
    ).rejects.toThrow(
      /lockunspent failed: Wallet is locked; without the persistent flag: Wallet is locked/,
    );
  });
});
