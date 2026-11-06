import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resetUniqueCache,
  setVerdictFile,
  verifyProviderCoins,
} from '../../../lib/blake2b/ProviderCoins';
import { resetKnownTransactions } from '../../../lib/blake2b/PrunedHistory';
import type { IChainClient } from '../../../lib/chain/ChainClient';

// D38: the D26 wallet guard on a node without txindex

const FORK = 200;
const TIP = 300;
const DER_ALL = `3044${'00'.repeat(68)}01`;
const NO_INDEX =
  'No such mempool transaction. Use -txindex or provide a block hash to enable blockchain transaction queries.';

type FakeTx = { height?: number; coinbase?: boolean; parents?: string[] };

const wallet = (txs: Record<string, FakeTx>, utxos: string[]) => {
  const locks: unknown[][] = [];
  const client = {
    symbol: 'SHA256',
    getBlockchainInfo: jest.fn(async () => ({ blocks: TIP })),
    listUnspent: jest.fn(async () =>
      utxos.map((txid) => ({ txid, vout: 0, amount: 1, confirmations: 1 })),
    ),
    getRawTransactionVerbose: jest.fn(async (txid: string) => {
      const t = txs[txid];
      // Like a pruned node: anything it cannot place is "use -txindex"
      if (t === undefined) throw new Error(NO_INDEX);
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
    rpc: jest.fn(async () => {
      throw 'no result in RPC response';
    }),
    walletRpc: jest.fn(async (method: string, params: unknown[]) => {
      if (method !== 'lockunspent') throw new Error(`unexpected ${method}`);
      locks.push(params);
      return true;
    }),
  } as unknown as IChainClient;
  return { client, locks };
};

const other = () =>
  ({
    symbol: 'BTC',
    getBlockchainInfo: jest.fn(async () => ({ blocks: TIP })),
    getRawTransactionVerbose: jest.fn(async () => {
      throw new Error('No such mempool or blockchain transaction');
    }),
    rpc: jest.fn(async () => {
      throw 'no result in RPC response';
    }),
  }) as unknown as IChainClient;

describe('D26 wallet guard on a node without txindex (D38)', () => {
  beforeEach(() => {
    resetUniqueCache();
    resetKnownTransactions();
    setVerdictFile(undefined);
  });

  test('one unique input is enough even when another cannot be found', async () => {
    const { client, locks } = wallet(
      {
        fresh: { height: 250, coinbase: true },
        mix: { height: 270, parents: ['gone', 'fresh'] },
      },
      ['mix'],
    );
    await expect(
      verifyProviderCoins(client, other(), FORK, { isBlake2b: false }),
    ).resolves.toContain('all unique');
    expect(locks).toEqual([]);
  });

  test('a coin that cannot be proven is locked in memory, not refused', async () => {
    const { client, locks } = wallet(
      {
        fresh: { height: 250, coinbase: true },
        orphan: { height: 280, parents: ['gone'] },
      },
      ['fresh', 'orphan'],
    );
    const summary = await verifyProviderCoins(client, other(), FORK, {
      isBlake2b: false,
    });
    expect(summary).toContain('1 of 2 coin(s) unique');
    expect(summary).toContain('could not be proven');
    // Two arguments: an in-memory lock, checked again on the next start
    expect(locks).toEqual([[false, [{ txid: 'orphan', vout: 0 }]]]);
  });

  test('a coin proven shared still refuses startup', async () => {
    const { client } = wallet(
      {
        old: { height: 150, coinbase: true },
        deposit: { height: 290, parents: ['old'] },
      },
      ['deposit'],
    );
    await expect(
      verifyProviderCoins(client, other(), FORK, { isBlake2b: false }),
    ).rejects.toThrow(/can exist on the BTC chain too/);
  });

  test('unique verdicts are kept in the data dir and used after a restart', async () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'swapsha-')),
      'blake2b-verdicts.json',
    );
    setVerdictFile(file);
    const txs: Record<string, FakeTx> = {
      fresh: { height: 250, coinbase: true },
      child: { height: 260, parents: ['fresh'] },
    };
    const first = wallet(txs, ['child']);
    await verifyProviderCoins(first.client, other(), FORK, {
      isBlake2b: false,
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).SHA256).toHaveProperty(
      'child',
    );

    // A restart on a node that has since pruned both blocks
    resetUniqueCache();
    setVerdictFile(file);
    const pruned = wallet({}, ['child']);
    await expect(
      verifyProviderCoins(pruned.client, other(), FORK, { isBlake2b: false }),
    ).resolves.toContain('all unique');
    expect(pruned.locks).toEqual([]);
  });
});
