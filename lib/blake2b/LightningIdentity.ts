import { InvoiceFeature } from '../lightning/LightningClient';
import { ChainIdentityError } from './ChainIdentity';

/** option_blake2b (Lightning Fork docs/blake2b-chain-identity.md). */
export const OPTION_BLAKE2B = [512, 513];

/**
 * option_simple_taproot_chans, final and staging bits. Simple taproot channels
 * never carry option_unified_sigs, so their signatures have no 0x21 opt-in
 * (Lightning Fork docs/blake2b.md, Replay protection). Blueprint D32.
 */
export const SIMPLE_TAPROOT = [80, 81, 180, 181];

/**
 * SwapSha D23/D29/D32: an LND attached to the BLAKE2b currency must be
 * Lightning Fork (it advertises option_blake2b) and must not offer simple
 * taproot channels; an LND attached to the SHA-256 currency must not be
 * Lightning Fork. Throws, so startup fails closed.
 */
export const verifyLightningIdentity = (
  symbol: string,
  isBlake2b: boolean,
  featureBits: number[],
): string => {
  const bits = new Set(featureBits);
  const blake2b = OPTION_BLAKE2B.some((b) => bits.has(b));

  if (isBlake2b && !blake2b) {
    throw new ChainIdentityError(
      `${symbol} LND does not advertise option_blake2b (feature bit 512 or 513): it is not a Lightning Fork node on the BLAKE2b chain`,
    );
  }
  if (!isBlake2b && blake2b) {
    throw new ChainIdentityError(
      `${symbol} LND advertises option_blake2b (feature bit 512 or 513): it follows the BLAKE2b chain, not this one`,
    );
  }
  if (isBlake2b) {
    const taproot = SIMPLE_TAPROOT.filter((b) => bits.has(b));
    if (taproot.length > 0) {
      throw new ChainIdentityError(
        `${symbol} LND offers simple taproot channels (feature bit ${taproot.join(', ')}), which sign without SIGHASH_UNIFIED; turn off protocol.simple-taproot-chans`,
      );
    }
  }

  return isBlake2b
    ? `${symbol} LND: Lightning Fork on the BLAKE2b chain (option_blake2b), no simple taproot channels`
    : `${symbol} LND: not Lightning Fork (no option_blake2b)`;
};

/**
 * SwapSha D29: an invoice for a BLAKE2b (BTC) Lightning leg must set
 * option_blake2b, and one for a SHA-256 Lightning leg must not. Both chains
 * use the lnbcrt/lnbc prefix and the same chain_hash, so the bit is the only
 * marker. Throws before anything is locked.
 */
export const checkInvoiceChain = (
  symbol: string,
  isBlake2b: boolean,
  features: Set<InvoiceFeature> | undefined,
): void => {
  // No feature list counts as no option_blake2b (fail closed for BTC legs)
  const blake2b = features?.has(InvoiceFeature.OptionBlake2b) === true;
  if (isBlake2b && !blake2b) {
    throw new Error(
      `invoice is not for the ${symbol} (BLAKE2b) Lightning network: it does not set option_blake2b (feature bit 512 or 513)`,
    );
  }
  if (!isBlake2b && blake2b) {
    throw new Error(
      `invoice is for the BLAKE2b Lightning network, not ${symbol}: it sets option_blake2b (feature bit 512 or 513)`,
    );
  }
};
