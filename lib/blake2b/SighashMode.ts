import type { SighashMode } from 'boltz-core';

/**
 * Which signature hash each UTXO currency signs with.
 *
 * 'unified' (Knots SIGHASH_UNIFIED, 0x21) for the BLAKE2b chain, so every
 * transaction SwapSha signs there is invalid on the SHA-256 chain and cannot
 * be replayed (Blueprint D6). 'legacy' for everything else.
 *
 * Filled from the currency config (`blake2b = true`) before any client
 * connects, and enforced at connect time by ChainIdentity.
 */
const modes = new Map<string, SighashMode>();

export const setSighashMode = (symbol: string, mode: SighashMode): void => {
  modes.set(symbol, mode);
};

export const sighashModeFor = (symbol: string): SighashMode =>
  modes.get(symbol) ?? 'legacy';

export const isBlake2bCurrency = (symbol: string): boolean =>
  sighashModeFor(symbol) === 'unified';

/**
 * True for every UTXO Bitcoin currency SwapSha configures, on either chain
 * (BLAKE2b "BTC" or SHA-256 "SHA256", Blueprint D27), whatever its symbol.
 * Code that Boltz keys on the literal 'BTC' uses this instead.
 */
export const isSwapshaBitcoinCurrency = (symbol: string): boolean =>
  modes.has(symbol);
