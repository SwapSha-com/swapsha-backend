import type { IChainClient } from '../chain/ChainClient';
import { classifyCoin } from './ProviderCoins';
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
 * timeout.
 *
 * A rejection there is not proof of safety. Missing inputs may only mean a
 * replayable parent has not been replayed yet, and non-final only means the
 * other chain has not reached the lockup's nLockTime yet. So on any rejection
 * the backend walks the lockup's ancestry on its own chain (classifyCoin, the
 * same walk as the D26 wallet guard) and refuses unless the lockup provably
 * exists on its own chain only.
 */

let forkHeight: number | undefined;

/** Set once at startup, from the BLAKE2b node's deployment info. */
export const setReplayForkHeight = (height: number | undefined) => {
  forkHeight = height;
};
export const isReplayPair = (symbolA: string, symbolB: string): boolean =>
  isBlake2bCurrency(symbolA) !== isBlake2bCurrency(symbolB);

export const checkLockupReplay = async (
  lockupTransactionId: string,
  lockupTransactionHex: string,
  otherChain: IChainClient,
  ownChain?: IChainClient,
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

  if (ownChain === undefined) return undefined;

  if (forkHeight === undefined) {
    return `user lockup ${lockupTransactionId}: fork height unknown, cannot prove it exists on the ${ownChain.symbol} chain only`;
  }

  try {
    const { blocks } = await ownChain.getBlockchainInfo();
    const { verdict, reason: why } = await classifyCoin(
      ownChain,
      forkHeight,
      blocks,
      lockupTransactionId,
      { isBlake2b: isBlake2bCurrency(ownChain.symbol) },
    );
    if (verdict === 'shared') {
      return `user lockup ${lockupTransactionId} is replayable onto the ${other} chain once its ancestry is replayed: ${why}`;
    }
  } catch (error) {
    return `user lockup ${lockupTransactionId}: ${(error as Error).message ?? error}`;
  }

  return undefined;
};
