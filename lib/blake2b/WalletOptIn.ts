import { Script, type Transaction } from '@scure/btc-signer';
import { isUnifiedSignature } from './ProviderCoins';

/**
 * D38 S4: the inputs of a transaction the BLAKE2b chain's Knots wallet signed
 * that carry no SIGHASH_UNIFIED signature, by index.
 *
 * A wallet signature is the first witness element (P2WPKH, P2SH-P2WPKH,
 * Taproot key path) or the first scriptSig push (P2PKH). An input whose
 * signature opts in can never be valid on SHA-256. The wallet opts in for all
 * of these (D23 update, Nov 5: Taproot key path with 65-byte `0x21`
 * signatures). An input without it is still not replayable while D26 holds,
 * since its coin exists on this chain only, so callers warn and do not refuse.
 */
export const inputsWithoutOptIn = (tx: Transaction): number[] => {
  const missing: number[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    let sig = input.finalScriptWitness?.[0];
    if (
      (sig === undefined || sig.length === 0) &&
      input.finalScriptSig !== undefined &&
      input.finalScriptSig.length > 0
    ) {
      try {
        const push = Script.decode(input.finalScriptSig)[0];
        if (push instanceof Uint8Array) sig = push;
      } catch {
        // Not a parsable scriptSig: no signature found
      }
    }
    if (
      sig === undefined ||
      !isUnifiedSignature(Buffer.from(sig).toString('hex'))
    ) {
      missing.push(i);
    }
  }
  return missing;
};
