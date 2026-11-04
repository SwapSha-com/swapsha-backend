import { ChainIdentityError } from '../../../lib/blake2b/ChainIdentity';
import {
  checkInvoiceChain,
  verifyLightningIdentity,
} from '../../../lib/blake2b/LightningIdentity';
import { InvoiceFeature } from '../../../lib/lightning/LightningClient';

// Example feature sets: common lnd bits, plus 512 (option_blake2b) and 514
// (option_unified_sigs) on Lightning Fork
const LIGHTNING_FORK = [0, 5, 7, 9, 12, 14, 17, 23, 27, 31, 45, 55, 512, 514];
const STOCK_LND = [0, 5, 7, 9, 12, 14, 17, 23, 27, 31, 45, 55];

describe('verifyLightningIdentity (D23, D29, D32)', () => {
  test('accepts Lightning Fork on the BLAKE2b currency', () => {
    expect(verifyLightningIdentity('BTC', true, LIGHTNING_FORK)).toMatch(
      /Lightning Fork on the BLAKE2b chain/,
    );
  });

  test('accepts the odd option_blake2b bit too', () => {
    expect(() =>
      verifyLightningIdentity('BTC', true, [...STOCK_LND, 513]),
    ).not.toThrow();
  });

  test('refuses a stock LND on the BLAKE2b currency', () => {
    expect(() => verifyLightningIdentity('BTC', true, STOCK_LND)).toThrow(
      ChainIdentityError,
    );
    expect(() => verifyLightningIdentity('BTC', true, STOCK_LND)).toThrow(
      /not a Lightning Fork node/,
    );
  });

  test('refuses Lightning Fork on the SHA-256 currency', () => {
    expect(() =>
      verifyLightningIdentity('SHA256', false, LIGHTNING_FORK),
    ).toThrow(/follows the BLAKE2b chain/);
  });

  test('accepts a stock LND on the SHA-256 currency', () => {
    expect(verifyLightningIdentity('SHA256', false, STOCK_LND)).toMatch(
      /not Lightning Fork/,
    );
  });

  test.each([80, 81, 180, 181])(
    'refuses simple taproot channels (bit %i) on the BLAKE2b currency',
    (bit) => {
      expect(() =>
        verifyLightningIdentity('BTC', true, [...LIGHTNING_FORK, bit]),
      ).toThrow(/simple taproot channels/);
    },
  );
});

describe('checkInvoiceChain (D29)', () => {
  const fork = new Set([InvoiceFeature.MPP, InvoiceFeature.OptionBlake2b]);
  const stock = new Set([InvoiceFeature.MPP]);

  test('accepts a Lightning Fork invoice for the BTC leg', () => {
    expect(() => checkInvoiceChain('BTC', true, fork)).not.toThrow();
  });

  test('refuses an invoice without option_blake2b for the BTC leg', () => {
    expect(() => checkInvoiceChain('BTC', true, stock)).toThrow(
      /does not set option_blake2b/,
    );
  });

  test('accepts a stock invoice for the SHA256 leg', () => {
    expect(() => checkInvoiceChain('SHA256', false, stock)).not.toThrow();
  });

  test('refuses a Lightning Fork invoice for the SHA256 leg', () => {
    expect(() => checkInvoiceChain('SHA256', false, fork)).toThrow(
      /for the BLAKE2b Lightning network/,
    );
  });
});
