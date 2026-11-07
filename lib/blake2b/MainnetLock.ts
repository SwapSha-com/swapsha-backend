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

/** Why new swaps are turned down, or undefined when they are not */
export const swapsTurnedDownReason = (): string | undefined => reason;

/** Throws when new swaps are turned down. Call first in every swap creation path. */
export const checkSwapsAllowed = (): void => {
  if (reason !== undefined) {
    throw new Error(reason);
  }
};
