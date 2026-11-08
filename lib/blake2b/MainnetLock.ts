import { networkKind } from './ChainIdentity';

type CurrencyNetwork = { symbol: string; network: string };

let reason: string | undefined;

/**
 * Blueprint D7 and D37 (amended Nov 6): swaps on mainnet stay off until
 * Phase 5. With any currency on mainnet and SWAPSHA_ALLOW_MAINNET unset, the
 * backend still starts and runs its startup checks against the real nodes
 * (chain identity, the D26 guard, the Lightning checks), but every new swap
 * is turned down. A network name that cannot be read counts as mainnet, so a
 * misspelled config fails closed.
 */
export const mainnetLockReason = (
  currencies: CurrencyNetwork[],
): string | undefined => {
  if (process.env.SWAPSHA_ALLOW_MAINNET === '1') {
    return undefined;
  }

  const locked = currencies
    .filter(({ network }) => {
      try {
        return networkKind(network) === 'mainnet';
      } catch {
        return true;
      }
    })
    .map(({ symbol, network }) => `${symbol} (${network})`);

  if (locked.length === 0) {
    return undefined;
  }

  return `New swaps are turned down: mainnet stays off until Phase 5 (Blueprint D7, D37), and ${locked.join(', ')} ${locked.length === 1 ? 'is' : 'are'} configured for mainnet or an unknown network`;
};

/** Sets the lock from the configured currencies; returns its reason */
export const setMainnetLock = (
  currencies: CurrencyNetwork[],
): string | undefined => {
  reason = mainnetLockReason(currencies);
  return reason;
};

let pauseReason: string | undefined;

/**
 * SwapSha build step A3c: the operator's pause, `pauseNewSwaps = true` in
 * the config (the StartOS package sets it from its Pause action and restarts
 * the backend). New swaps are turned down; swaps already made carry on to
 * their claim or refund, including a submarine swap whose invoice is set
 * after the pause began.
 */
export const operatorPauseReason =
  'New swaps are paused by the operator; swaps already made carry on';

/** Sets the operator's pause; returns its reason */
export const setOperatorPause = (paused: boolean): string | undefined => {
  pauseReason = paused ? operatorPauseReason : undefined;
  return pauseReason;
};

/** Why new swaps are turned down, or undefined when they are not */
export const swapsTurnedDownReason = (): string | undefined => {
  const reasons = [reason, pauseReason].filter(
    (entry): entry is string => entry !== undefined,
  );
  return reasons.length === 0 ? undefined : reasons.join('. ');
};

/**
 * Throws when new swaps are turned down. Call first in every swap creation
 * path. `forExistingSwap` is for steps of a swap made earlier (setting a
 * submarine swap's invoice), which the operator's pause lets through and
 * the mainnet lock does not.
 */
export const checkSwapsAllowed = (forExistingSwap = false): void => {
  const turnedDown = forExistingSwap ? reason : swapsTurnedDownReason();
  if (turnedDown !== undefined) {
    throw new Error(turnedDown);
  }
};
