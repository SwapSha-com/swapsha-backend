import {
  checkLockupReplay,
  isReplayPair,
  setReplayForkHeight,
} from '../../../lib/blake2b/ReplayGuard';
import { setSighashMode } from '../../../lib/blake2b/SighashMode';
import type { IChainClient } from '../../../lib/chain/ChainClient';

const other = (opts: { known?: boolean; allowed?: boolean; reason?: string }) =>
  ({
    symbol: 'XBT',
    getRawTransaction: jest.fn(async () => {
      if (opts.known) return '00';
      throw new Error('No such mempool or blockchain transaction');
    }),
    testMempoolAccept: jest.fn(async () => [
      {
        txid: 'id',
        wtxid: 'wid',
        allowed: opts.allowed,
        'reject-reason': opts.reason,
      },
    ]),
  }) as unknown as IChainClient;

describe('ReplayGuard (D18)', () => {
  beforeAll(() => {
    setSighashMode('BTC', 'legacy');
    setSighashMode('XBT', 'unified');
  });

  test('only BTC/XBT pairs are checked', () => {
    expect(isReplayPair('BTC', 'XBT')).toBe(true);
    expect(isReplayPair('XBT', 'BTC')).toBe(true);
    expect(isReplayPair('BTC', 'L-BTC')).toBe(false);
  });

  test('safe when the other chain lacks the inputs', async () => {
    await expect(
      checkLockupReplay(
        'id',
        'hex',
        other({ allowed: false, reason: 'missing-inputs' }),
      ),
    ).resolves.toBeUndefined();
  });

  test('safe when the other chain rejects the signature (SIGHASH_UNIFIED)', async () => {
    await expect(
      checkLockupReplay(
        'id',
        'hex',
        other({
          allowed: false,
          reason: 'mandatory-script-verify-flag-failed',
        }),
      ),
    ).resolves.toBeUndefined();
  });

  test('flags a lockup the other chain would accept', async () => {
    await expect(
      checkLockupReplay('id', 'hex', other({ allowed: true })),
    ).resolves.toContain('replayable');
  });

  test('flags a lockup already on the other chain', async () => {
    await expect(
      checkLockupReplay('id', 'hex', other({ known: true })),
    ).resolves.toContain('replayed');
  });

  test('flags a lockup already in the other mempool', async () => {
    await expect(
      checkLockupReplay(
        'id',
        'hex',
        other({ allowed: false, reason: 'txn-already-in-mempool' }),
      ),
    ).resolves.toContain('replayed');
  });

  describe('missing inputs: walk the lockup ancestry on its own chain', () => {
    const TIP = 300;
    const own = (
      txs: Record<
        string,
        { height: number; coinbase?: boolean; parents?: string[] }
      >,
    ) =>
      ({
        symbol: 'BTC',
        getBlockchainInfo: jest.fn(async () => ({ blocks: TIP })),
        getRawTransactionVerbose: jest.fn(async (txid: string) => {
          const t = txs[txid];
          if (t === undefined) throw new Error('No such transaction');
          return {
            txid,
            confirmations: TIP - t.height + 1,
            vin: t.coinbase
              ? [{ coinbase: '03' }]
              : (t.parents ?? []).map((p) => ({
                  txid: p,
                  vout: 0,
                  scriptSig: { asm: '', hex: '' },
                  txinwitness: [],
                })),
          };
        }),
      }) as unknown as IChainClient;
    const missing = () => other({ allowed: false, reason: 'missing-inputs' });

    afterEach(() => setReplayForkHeight(undefined));

    test('flags a lockup whose parent is a replayable, not yet replayed, deposit', async () => {
      setReplayForkHeight(200);
      const chain = own({
        old: { height: 150, coinbase: true },
        deposit: { height: 260, parents: ['old'] },
        lockup: { height: 280, parents: ['deposit'] },
      });
      await expect(
        checkLockupReplay('lockup', 'hex', missing(), chain),
      ).resolves.toContain('once its ancestry is replayed');
    });

    test('passes a lockup that descends from a post-fork coinbase', async () => {
      setReplayForkHeight(200);
      const chain = own({
        cb: { height: 250, coinbase: true },
        lockup: { height: 280, parents: ['cb'] },
      });
      await expect(
        checkLockupReplay('lockup', 'hex', missing(), chain),
      ).resolves.toBeUndefined();
    });

    test('fails closed when the fork height is unknown', async () => {
      await expect(
        checkLockupReplay('lockup', 'hex', missing(), own({})),
      ).resolves.toContain('fork height unknown');
    });

    test('fails closed when the ancestry cannot be fetched', async () => {
      setReplayForkHeight(200);
      await expect(
        checkLockupReplay('lockup', 'hex', missing(), own({})),
      ).resolves.toContain('txindex');
    });
  });
});
