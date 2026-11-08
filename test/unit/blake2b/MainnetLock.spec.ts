import {
  checkSwapsAllowed,
  mainnetLockReason,
  operatorPauseReason,
  setMainnetLock,
  setOperatorPause,
  swapsTurnedDownReason,
} from '../../../lib/blake2b/MainnetLock';

describe('MainnetLock', () => {
  afterEach(() => {
    delete process.env.SWAPSHA_ALLOW_MAINNET;
    setMainnetLock([]);
    setOperatorPause(false);
  });

  test.each([
    'regtest',
    'bitcoinRegtest',
    'testnet',
    'testnet4',
    'bitcoinTestnet',
  ])('leaves swaps on for %s', (network) => {
    expect(
      mainnetLockReason([
        { symbol: 'BTC', network },
        { symbol: 'SHA256', network },
      ]),
    ).toBeUndefined();
  });

  test.each(['mainnet', 'bitcoinMainnet', 'bitcoin'])(
    'turns swaps down for %s',
    (network) => {
      expect(
        mainnetLockReason([
          { symbol: 'BTC', network },
          { symbol: 'SHA256', network: 'regtest' },
        ]),
      ).toEqual(
        `New swaps are turned down: mainnet stays off until Phase 5 (Blueprint D7, D37), and BTC (${network}) is configured for mainnet or an unknown network`,
      );
    },
  );

  test('names every currency on mainnet', () => {
    expect(
      mainnetLockReason([
        { symbol: 'BTC', network: 'mainnet' },
        { symbol: 'SHA256', network: 'mainnet' },
      ]),
    ).toContain('BTC (mainnet), SHA256 (mainnet) are configured');
  });

  test('fails closed on a network name it cannot read', () => {
    expect(
      mainnetLockReason([{ symbol: 'BTC', network: 'bitcoinMoon' }]),
    ).toContain('BTC (bitcoinMoon) is configured');
  });

  test('SWAPSHA_ALLOW_MAINNET=1 lifts it (Phase 5)', () => {
    process.env.SWAPSHA_ALLOW_MAINNET = '1';
    expect(
      mainnetLockReason([{ symbol: 'BTC', network: 'mainnet' }]),
    ).toBeUndefined();
  });

  test('any other value of SWAPSHA_ALLOW_MAINNET does not', () => {
    process.env.SWAPSHA_ALLOW_MAINNET = 'true';
    expect(
      mainnetLockReason([{ symbol: 'BTC', network: 'mainnet' }]),
    ).toBeDefined();
  });

  test('checkSwapsAllowed throws while the lock is set', () => {
    expect(setMainnetLock([{ symbol: 'BTC', network: 'mainnet' }])).toBe(
      swapsTurnedDownReason(),
    );
    expect(() => checkSwapsAllowed()).toThrow('New swaps are turned down');

    setMainnetLock([{ symbol: 'BTC', network: 'regtest' }]);
    expect(swapsTurnedDownReason()).toBeUndefined();
    expect(() => checkSwapsAllowed()).not.toThrow();
  });

  describe('operator pause (A3c)', () => {
    test('turns new swaps down', () => {
      expect(setOperatorPause(true)).toEqual(operatorPauseReason);
      expect(swapsTurnedDownReason()).toEqual(operatorPauseReason);
      expect(() => checkSwapsAllowed()).toThrow(
        'New swaps are paused by the operator',
      );
    });

    test('lets a step of an existing swap through', () => {
      setOperatorPause(true);
      expect(() => checkSwapsAllowed(true)).not.toThrow();
    });

    test('the mainnet lock does not let it through', () => {
      setMainnetLock([{ symbol: 'BTC', network: 'mainnet' }]);
      expect(() => checkSwapsAllowed(true)).toThrow(
        'New swaps are turned down',
      );
    });

    test('names both reasons when both apply', () => {
      setMainnetLock([{ symbol: 'BTC', network: 'mainnet' }]);
      setOperatorPause(true);
      const turnedDown = swapsTurnedDownReason()!;
      expect(turnedDown).toContain('mainnet stays off until Phase 5');
      expect(turnedDown).toContain(operatorPauseReason);
    });

    test('lifting it lets new swaps through', () => {
      setOperatorPause(true);
      expect(setOperatorPause(false)).toBeUndefined();
      expect(swapsTurnedDownReason()).toBeUndefined();
      expect(() => checkSwapsAllowed()).not.toThrow();
    });
  });
});
