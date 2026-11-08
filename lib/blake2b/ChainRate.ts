import { getRate } from '../Utils';
import { OrderSide } from '../consts/Enums';

/**
 * SwapSha D5 and D19: the BTC/SHA256 pair has an operator-set rate, the
 * number of quote coins (SHA-256) one base coin (BTC) is worth. Boltz keeps
 * that one number for both directions of a chain swap (the hardcoded pair in
 * RateProviderTaproot) and turns it per order side when a swap is created
 * (Service.createChainSwap). Upstream Boltz runs hardcoded pairs at a rate
 * of 1, where the turn makes no difference; these helpers are the same rule
 * for every other place that needs it.
 */

/** What one unit the user locks is worth in units the server locks */
export const chainSwapRate = (pairRate: number, orderSide: OrderSide): number =>
  getRate(pairRate, orderSide, true);

/**
 * The user's lock amount in quote units, the unit of the chain swap limits.
 * The same conversion Service.verifyAmount makes when a swap is created: on
 * the sell side the user locks the base coin, on the buy side the quote coin.
 */
export const chainLimitAmount = (
  userLockAmount: number,
  pairRate: number,
  orderSide: OrderSide,
): number =>
  orderSide === OrderSide.SELL
    ? Math.floor(userLockAmount * chainSwapRate(pairRate, orderSide))
    : userLockAmount;
