import type { IChainClient } from '../chain/ChainClient';
import { isBlake2bCurrency } from './SighashMode';

/**
 * D18: before the backend locks its side of a chain swap, make sure the
 * user's lockup cannot also exist on the other chain.
 *
 * A transaction spending coins from before the fork and signed the old way is
 * valid on both chains. If the user's lockup is like that, anyone can replay
 * it onto the other chain, and the backend's view of "the user has paid" no
 * longer matches one chain. So the backend asks the other chain's node:
 *
 * - does that chain already have the transaction? (replayed)
 * - would it accept the transaction now? (replayable)
 *
 * Either answer refuses the swap; the user refunds their lockup after the
 * timeout. Missing inputs or an invalid signature there means the transaction
 * can only ever exist on its own chain.
 */
export const isReplayPair = (symbolA: string, symbolB: string): boolean =>
  isBlake2bCurrency(symbolA) !== isBlake2bCurrency(symbolB);

export const checkLockupReplay = async (
  lockupTransactionId: string,
  lockupTransactionHex: string,
  otherChain: IChainClient,
): Promise<string | undefined> => {
  const other = otherChain.symbol;

  try {
    await otherChain.getRawTransaction(lockupTransactionId);
    return `user lockup ${lockupTransactionId} already exists on the ${other} chain (replayed)`;
  } catch {
    // Not known there: the expected case
  }

  const [result] = await otherChain.testMempoolAccept([lockupTransactionHex]);
  if (result?.allowed === true) {
    return `user lockup ${lockupTransactionId} is valid on the ${other} chain too (replayable: pre-fork coins signed without SIGHASH_UNIFIED)`;
  }

  const reason = result?.['reject-reason'] ?? '';
  if (/already|txn-already/i.test(reason)) {
    return `user lockup ${lockupTransactionId} is already in the ${other} mempool (replayed)`;
  }

  return undefined;
};
