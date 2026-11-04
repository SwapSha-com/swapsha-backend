import {
  blocksToOutlast,
  blocksWithin,
  getPaceBounds,
  resetPaceBounds,
  setPaceBounds,
  staleChainReason,
  staleTipReason,
} from '../../../lib/blake2b/ChainPace';

// Testnet4, 144-block windows since the fork (SwapSha_Phase2_Scope.md section 8)
const SHA256 = { fastMinutesPerBlock: 6.17, slowMinutesPerBlock: 18.92 };
const BTC = { fastMinutesPerBlock: 20.26, slowMinutesPerBlock: 59.44 };

describe('ChainPace (D30)', () => {
  beforeEach(() => resetPaceBounds());

  test('without bounds, a chain runs at its nominal block time', () => {
    const nominal = getPaceBounds('SHA256', 10);
    expect(nominal).toEqual({ fastMinutesPerBlock: 10, slowMinutesPerBlock: 10 });
    expect(blocksToOutlast(12, nominal, nominal)).toBe(12);
    expect(blocksWithin(12, nominal, nominal)).toBe(12);
  });

  test('a leg that must outlast assumes the other chain slow and its own fast', () => {
    // 12 BTC blocks can take up to 713 minutes; SHA256 can do 116 blocks in that
    expect(blocksToOutlast(12, BTC, SHA256)).toBe(116);
    expect(blocksToOutlast(20, SHA256, BTC)).toBe(19);
  });

  test('a leg that must end first assumes the other chain fast and its own slow', () => {
    // 144 SHA256 blocks can pass in 888 minutes; BTC is sure of only 14 in that
    expect(blocksWithin(144, SHA256, BTC)).toBe(14);
  });

  test('outlast and within never meet in the unsafe direction', () => {
    for (const blocks of [1, 6, 12, 72, 144, 288]) {
      const there = blocksToOutlast(blocks, SHA256, BTC);
      expect(blocksWithin(there, BTC, SHA256)).toBeLessThanOrEqual(
        blocksToOutlast(there, BTC, SHA256),
      );
      expect(blocksWithin(blocks, SHA256, BTC)).toBeLessThanOrEqual(there);
    }
  });

  test('configured bounds replace the nominal block time', () => {
    setPaceBounds('BTC', BTC);
    expect(getPaceBounds('BTC', 10)).toEqual(BTC);
  });

  test.each([
    [{ fastMinutesPerBlock: 0, slowMinutesPerBlock: 10 }],
    [{ fastMinutesPerBlock: 20, slowMinutesPerBlock: 10 }],
    [{ fastMinutesPerBlock: 5, slowMinutesPerBlock: 10, maxTipAgeMinutes: 0 }],
  ])('refuses impossible bounds %j', (pace) => {
    expect(() => setPaceBounds('BTC', pace)).toThrow();
  });
});

describe('stall guard (D30)', () => {
  const now = 1_800_000_000;
  beforeEach(() => resetPaceBounds());

  test('is off unless maxTipAgeMinutes is set', () => {
    setPaceBounds('BTC', BTC);
    expect(staleTipReason('BTC', now - 100 * 3600, now)).toBeUndefined();
  });

  test('passes a tip within the limit and stops one past it', () => {
    setPaceBounds('BTC', { ...BTC, maxTipAgeMinutes: 120 });
    expect(staleTipReason('BTC', now - 119 * 60, now)).toBeUndefined();
    expect(staleTipReason('BTC', now - 121 * 60, now)).toMatch(
      /BTC chain tip is 121 minutes old \(limit 120\)/,
    );
  });

  test('asks only guarded chains, and reports the stale one', async () => {
    setPaceBounds('BTC', { ...BTC, maxTipAgeMinutes: 120 });
    const unguarded = {
      symbol: 'SHA256',
      getBlockchainInfo: jest.fn(),
      getBlock: jest.fn(),
    };
    const stalled = {
      symbol: 'BTC',
      getBlockchainInfo: jest.fn(async () => ({ bestblockhash: 'tip' })),
      getBlock: jest.fn(async () => ({ time: now - 40 * 3600 })),
    };
    await expect(
      staleChainReason([unguarded, stalled, undefined], now),
    ).resolves.toMatch(/BTC chain tip is 2400 minutes old/);
    expect(unguarded.getBlockchainInfo).not.toHaveBeenCalled();
  });

  test('is quiet when every guarded chain is fresh', async () => {
    setPaceBounds('BTC', { ...BTC, maxTipAgeMinutes: 120 });
    const fresh = {
      symbol: 'BTC',
      getBlockchainInfo: jest.fn(async () => ({ bestblockhash: 'tip' })),
      getBlock: jest.fn(async () => ({ time: now - 600 })),
    };
    await expect(staleChainReason([fresh], now)).resolves.toBeUndefined();
  });
});
