import {
  checkLockupReplay,
  isReplayPair,
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
});
