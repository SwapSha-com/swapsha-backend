import { ChainIdentityError } from '../../../lib/blake2b/ChainIdentity';
import {
  isUnifiedSignature,
  verifyProviderCoins,
} from '../../../lib/blake2b/ProviderCoins';
import type { IChainClient } from '../../../lib/chain/ChainClient';

const FORK = 200;
const TIP = 300;

type FakeTx = {
  height?: number;
  coinbase?: boolean;
  parents?: string[];
  witness0?: string;
  asm?: string;
};

// Real signature shapes: DER + 0x21, Schnorr + 0x21, DER + 0x01, Schnorr 64B
const DER_UNIFIED = `3044${'00'.repeat(68)}21`;
const SCHNORR_UNIFIED = `${'ab'.repeat(64)}21`;
const DER_ALL = `3044${'00'.repeat(68)}01`;
const SCHNORR_DEFAULT = 'ab'.repeat(64);

const chain = (
  symbol: string,
  txs: Record<string, FakeTx>,
  utxos: string[],
  elsewhere: string[] = [],
) =>
  ({
    symbol,
    getBlockchainInfo: jest.fn(async () => ({ blocks: TIP })),
    listUnspent: jest.fn(async () =>
      utxos.map((txid) => ({ txid, vout: 0, amount: 1, confirmations: 1 })),
    ),
    getRawTransactionVerbose: jest.fn(async (txid: string) => {
      const t = txs[txid];
      if (t === undefined)
        throw new Error('No such mempool or blockchain transaction');
      return {
        txid,
        confirmations: t.height === undefined ? 0 : TIP - t.height + 1,
        vin: t.coinbase
          ? [{ coinbase: '03' }]
          : (t.parents ?? []).map((p) => ({
              txid: p,
              vout: 0,
              scriptSig: { asm: t.asm ?? '', hex: '' },
              txinwitness: t.witness0 === undefined ? [] : [t.witness0],
            })),
      };
    }),
    rpc: jest.fn(async (method: string, params: unknown[]) =>
      method === 'gettxout' && elsewhere.includes(params[0] as string)
        ? { value: 1 }
        : null,
    ),
  }) as unknown as IChainClient;

const other = (elsewhere: string[] = []) => chain('XBT', {}, [], elsewhere);

describe('isUnifiedSignature', () => {
  test.each([
    [DER_UNIFIED, true],
    [SCHNORR_UNIFIED, true],
    [DER_ALL, false],
    [SCHNORR_DEFAULT, false],
    // A 32-byte preimage ending in 0x21 is not a signature
    [`${'00'.repeat(31)}21`, false],
  ])('%s -> %s', (sig, want) => {
    expect(isUnifiedSignature(sig)).toBe(want);
  });
});

describe('verifyProviderCoins', () => {
  test('passes post-fork coinbases and their descendants', async () => {
    const btc = chain(
      'BTC',
      {
        cb: { height: 250, coinbase: true },
        change: { height: 260, parents: ['cb'], witness0: SCHNORR_DEFAULT },
      },
      ['cb', 'change'],
    );
    await expect(
      verifyProviderCoins(btc, other(), FORK, { isBlake2b: false }),
    ).resolves.toContain('all unique to this chain');
  });

  test('refuses a coin confirmed before the fork', async () => {
    const btc = chain('BTC', { old: { height: 150, coinbase: true } }, ['old']);
    await expect(
      verifyProviderCoins(btc, other(), FORK, { isBlake2b: false }),
    ).rejects.toThrow(/before the fork/);
  });

  test('refuses a post-fork deposit that spent a pre-fork coin without opting in', async () => {
    // The gap a height-only check misses: the deposit is at 280, after the
    // fork, but it is replayable, so the same coin can appear on XBT.
    const btc = chain(
      'BTC',
      {
        old: { height: 150, coinbase: true },
        deposit: { height: 280, parents: ['old'], witness0: DER_ALL },
      },
      ['deposit'],
    );
    await expect(
      verifyProviderCoins(btc, other(), FORK, { isBlake2b: false }),
    ).rejects.toThrow(/can be replayed|can exist on the XBT chain too/);
  });

  test('on XBT, accepts a pre-fork-derived deposit that opted in', async () => {
    const xbt = chain(
      'XBT',
      {
        old: { height: 150, coinbase: true },
        deposit: { height: 280, parents: ['old'], witness0: DER_UNIFIED },
      },
      ['deposit'],
    );
    await expect(
      verifyProviderCoins(xbt, chain('BTC', {}, []), FORK, { isBlake2b: true }),
    ).resolves.toContain('all unique');
  });

  test('on XBT, a legacy scriptSig marked UNIFIED counts as opted in', async () => {
    const xbt = chain(
      'XBT',
      {
        old: { height: 150, coinbase: true },
        deposit: {
          height: 280,
          parents: ['old'],
          asm: '3044...[ALL|UNIFIED] 02ab',
        },
      },
      ['deposit'],
    );
    await expect(
      verifyProviderCoins(xbt, chain('BTC', {}, []), FORK, { isBlake2b: true }),
    ).resolves.toContain('all unique');
  });

  test('on BTC, an opt-in-looking signature does not make a coin unique', async () => {
    const btc = chain(
      'BTC',
      {
        old: { height: 150, coinbase: true },
        deposit: { height: 280, parents: ['old'], witness0: DER_UNIFIED },
      },
      ['deposit'],
    );
    await expect(
      verifyProviderCoins(btc, other(), FORK, { isBlake2b: false }),
    ).rejects.toThrow(ChainIdentityError);
  });

  test('one unique input is enough', async () => {
    const btc = chain(
      'BTC',
      {
        old: { height: 150, coinbase: true },
        fresh: { height: 250, coinbase: true },
        mix: { height: 270, parents: ['old', 'fresh'], witness0: DER_ALL },
      },
      ['mix'],
    );
    await expect(
      verifyProviderCoins(btc, other(), FORK, { isBlake2b: false }),
    ).resolves.toContain('all unique');
  });

  test('refuses a coin the other chain already has, whatever its ancestry', async () => {
    const btc = chain('BTC', { cb: { height: 250, coinbase: true } }, ['cb']);
    await expect(
      verifyProviderCoins(btc, other(['cb']), FORK, { isBlake2b: false }),
    ).rejects.toThrow(/also exists on the XBT chain/);
  });

  test('fails closed when an ancestor cannot be fetched', async () => {
    const btc = chain(
      'BTC',
      { deposit: { height: 280, parents: ['gone'], witness0: DER_ALL } },
      ['deposit'],
    );
    await expect(
      verifyProviderCoins(btc, other(), FORK, { isBlake2b: false }),
    ).rejects.toThrow(/txindex/);
  });

  test('fails closed when the walk is too long', async () => {
    const txs: Record<string, FakeTx> = { t0: { height: 150, coinbase: true } };
    for (let i = 1; i <= 20; i++) {
      txs[`t${i}`] = {
        height: 210 + i,
        parents: [`t${i - 1}`],
        witness0: DER_ALL,
      };
    }
    const btc = chain('BTC', txs, ['t20']);
    await expect(
      verifyProviderCoins(btc, other(), FORK, {
        isBlake2b: false,
        maxVisits: 5,
      }),
    ).rejects.toThrow(/longer than 5/);
  });

  test('passes an empty wallet', async () => {
    await expect(
      verifyProviderCoins(chain('BTC', {}, []), other(), FORK, {
        isBlake2b: false,
      }),
    ).resolves.toContain('0 confirmed');
  });
});
