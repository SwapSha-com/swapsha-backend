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
