/**
 * SwapSha D30 (amended Nov 4): wall-clock timelocks.
 *
 * A timelock counted in one chain's blocks expires at a time that depends on
 * that chain's pace, and the two chains run at very different and changing
 * paces (testnet4 data: SwapSha_Phase2_Scope.md section 8). Each currency may
 * set measured bounds in minutes per block; conversions between chains then
 * assume the worst pairing. Without bounds, a chain is taken at its nominal
 * block time, which keeps the upstream Boltz behaviour.
 */

export type PaceBounds = {
  /** Fastest measured pace, minutes per block */
  fastMinutesPerBlock: number;
  /** Slowest measured pace, minutes per block */
  slowMinutesPerBlock: number;
  /** Stall guard: refuse Lightning swaps when the tip is older than this */
  maxTipAgeMinutes?: number;
};

const bounds = new Map<string, PaceBounds>();

export const setPaceBounds = (symbol: string, pace: PaceBounds): void => {
  const { fastMinutesPerBlock: fast, slowMinutesPerBlock: slow } = pace;
  if (!(fast > 0) || !(slow >= fast)) {
    throw new Error(
      `${symbol}: pace needs 0 < fastMinutesPerBlock <= slowMinutesPerBlock (got ${fast}, ${slow})`,
    );
  }
  if (pace.maxTipAgeMinutes !== undefined && !(pace.maxTipAgeMinutes > 0)) {
    throw new Error(`${symbol}: maxTipAgeMinutes must be positive`);
  }
  bounds.set(symbol, pace);
};

/** Test hook */
export const resetPaceBounds = (): void => bounds.clear();

export const getPaceBounds = (
  symbol: string,
  nominalMinutesPerBlock: number,
): PaceBounds =>
  bounds.get(symbol) ?? {
    fastMinutesPerBlock: nominalMinutesPerBlock,
    slowMinutesPerBlock: nominalMinutesPerBlock,
  };

/**
 * Blocks on `to` that are sure to outlast `blocks` on `from`: `from` at its
 * slowest, `to` at its fastest. For a leg that must still be open when the
 * other one has expired (the first leg of a reverse or chain swap, the chain
 * HTLC behind a Lightning payment).
 */
export const blocksToOutlast = (
  blocks: number,
  from: PaceBounds,
  to: PaceBounds,
): number =>
  Math.ceil((blocks * from.slowMinutesPerBlock) / to.fastMinutesPerBlock);

/**
 * Blocks on `to` that are sure to end before `blocks` on `from`: `from` at its
 * fastest, `to` at its slowest. For a leg that must be over before the other
 * one expires (SwapSha's outgoing Lightning payment against the user's
 * on-chain refund).
 */
export const blocksWithin = (
  blocks: number,
  from: PaceBounds,
  to: PaceBounds,
): number =>
  Math.floor((blocks * from.fastMinutesPerBlock) / to.slowMinutesPerBlock);

/**
 * Stall guard. A stall has no upper bound (BLAKE2b testnet4 had no block for
 * 39.9 hours), so no margin covers it; instead Lightning swaps are not offered,
 * paid or locked while a chain's tip is too old. Returns a reason, or
 * undefined when fresh or when the currency sets no maxTipAgeMinutes.
 */
export const staleTipReason = (
  symbol: string,
  tipTimeSeconds: number,
  nowSeconds: number,
): string | undefined => {
  const maxAge = bounds.get(symbol)?.maxTipAgeMinutes;
  if (maxAge === undefined) return undefined;
  const ageMinutes = (nowSeconds - tipTimeSeconds) / 60;
  if (ageMinutes <= maxAge) return undefined;
  return `${symbol} chain tip is ${Math.floor(ageMinutes)} minutes old (limit ${maxAge}); Lightning swaps are paused until it moves`;
};

/** Whether a currency has the stall guard on */
export const hasStallGuard = (symbol: string): boolean =>
  bounds.get(symbol)?.maxTipAgeMinutes !== undefined;

type TipClient = {
  symbol: string;
  getBlockchainInfo(): Promise<{ bestblockhash: string }>;
  getBlock(hash: string): Promise<{ time: number }>;
};

/**
 * Stall guard over the given chain clients: the first reason found, or
 * undefined when every guarded chain is fresh. Chains without the guard are
 * not asked anything.
 */
export const staleChainReason = async (
  clients: (TipClient | undefined)[],
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string | undefined> => {
  for (const client of clients) {
    if (client === undefined || !hasStallGuard(client.symbol)) continue;
    const { bestblockhash } = await client.getBlockchainInfo();
    const { time } = await client.getBlock(bestblockhash);
    const reason = staleTipReason(client.symbol, time, nowSeconds);
    if (reason !== undefined) return reason;
  }
  return undefined;
};
