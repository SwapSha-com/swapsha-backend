import type ChainClient from '../chain/ChainClient';
import type { IChainClient } from '../chain/ChainClient';
import type { BlockVerbose, RawTransaction } from '../consts/Types';
import { ChainIdentityError } from './ChainIdentity';

/**
 * Blueprint 4.4 / D26: every coin in a provider wallet must exist on its own
 * chain only. A coin that also exists on the other chain can be spent there by
 * replaying our transaction, because the SHA-256 chain has no SIGHASH_UNIFIED
 * and the Knots wallet does not opt in on Taproot key-path spends.
 *
 * Checking the coin's own height is not enough. A coin received after the fork
 * is still shared if the transaction that created it spent shared coins and
 * did not opt in: that transaction is valid on both chains, so anyone can
 * replay it and create the same coin on the other side. So we walk each coin's
 * ancestry until the answer is certain:
 *
 *   - confirmed before the fork          -> shared (common history)
 *   - coinbase after the fork            -> unique to this chain
 *   - on the BLAKE2b chain, any input
 *     signed with SIGHASH_UNIFIED        -> unique (invalid on SHA-256)
 *   - any input unique                   -> unique (missing on the other chain)
 *   - an input the other chain already
 *     spent in a different transaction  -> unique (a conflicting spend: the
 *                                            other chain can never accept it)
 *   - otherwise                          -> shared (replayable)
 *
 * Before the walk, each coin is looked up on the other chain directly: if it is
 * already there, it is shared no matter what the walk would say.
 *
 * Fails closed: a transaction we cannot fetch (no txindex) or a walk longer
 * than `maxVisits` refuses startup.
 */

export type Uniqueness = 'unique' | 'shared';

type Verdict = { verdict: Uniqueness; reason: string };

type Options = {
  /** True when `client` is the BLAKE2b chain, where opted-in signatures count */
  isBlake2b: boolean;
  maxVisits?: number;
  /**
   * The other chain's client. When given, a post-fork transaction whose input
   * the other chain has already spent in a different, confirmed transaction
   * counts as unique: it conflicts with that chain's history, so it can never
   * be valid there. This is how a coin from before the fork is split.
   */
  other?: IChainClient;
  /**
   * How many blocks deep that conflicting spend must be before the split is
   * trusted. A reorg on the other chain that drops the spend would undo the
   * split, so a shallower spend counts as shared for now (retry later).
   * Defaults to the value set with setConflictDepth.
   */
  minConflictDepth?: number;
};

/** Testnet default; Boltz raises it on mainnet at startup. */
export const DEFAULT_CONFLICT_DEPTH = 6;
export const MAINNET_CONFLICT_DEPTH = 100;
let conflictDepth = DEFAULT_CONFLICT_DEPTH;

/** Set once at startup from the configured network. */
export const setConflictDepth = (depth: number) => {
  if (!Number.isInteger(depth) || depth < 1) {
    throw new ChainIdentityError(
      `conflict depth must be a positive integer, got ${depth}`,
    );
  }
  conflictDepth = depth;
};

const SIGHASH_UNIFIED = 0x20;

/** True when a witness element is a signature carrying the SIGHASH_UNIFIED bit. */
export const isUnifiedSignature = (element: string): boolean => {
  if (element.length < 2) return false;
  const bytes = element.length / 2;
  const hashType = parseInt(element.slice(-2), 16);
  if ((hashType & SIGHASH_UNIFIED) === 0) return false;
  // Schnorr with an explicit hash type
  if (bytes === 65) return true;
  // DER: 0x30, length of the rest minus the hash type byte
  return (
    element.startsWith('30') &&
    parseInt(element.slice(2, 4), 16) === bytes - 3 &&
    bytes >= 9 &&
    bytes <= 73
  );
};

/** True when any input of the transaction opted in to SIGHASH_UNIFIED. */
export const optsIn = (tx: RawTransaction): boolean =>
  tx.vin.some((input) => {
    if (/\|UNIFIED\]/.test(input.scriptSig?.asm ?? '')) return true;
    const first = input.txinwitness?.[0];
    return first !== undefined && isUnifiedSignature(first);
  });

const isCoinbase = (tx: RawTransaction) =>
  tx.vin.length === 1 &&
  (tx.vin[0] as unknown as { coinbase?: string }).coinbase !== undefined;

// RpcClient rejects a null result with this string; gettxout answers null
// for "no such unspent output".
const NO_RESULT_RPC = 'no result in RPC response';
const NOT_FOUND = /No such mempool or blockchain transaction/i;

const errorText = (error: unknown) =>
  typeof error === 'string' ? error : ((error as Error)?.message ?? `${error}`);

/** The other chain's confirmed transaction, or undefined when it has none. */
const fetchOnOther = async (
  other: IChainClient,
  txid: string,
): Promise<RawTransaction | undefined> => {
  try {
    return await other.getRawTransactionVerbose(txid);
  } catch (error) {
    if (NOT_FOUND.test(errorText(error))) return undefined;
    throw new ChainIdentityError(
      `${other.symbol} node: cannot look up ${txid} to check for a conflicting spend (is txindex=1 set?): ${errorText(error)}`,
    );
  }
};

// Blocks are immutable by hash, so a scan can be shared across one walk
const blockCache = new Map<string, BlockVerbose>();
const BLOCK_CACHE_MAX = 500;

const cachedBlock = async (
  other: Partial<ChainClient>,
  hash: string,
): Promise<BlockVerbose> => {
  const hit = blockCache.get(hash);
  if (hit !== undefined) return hit;
  const block = await other.getBlockVerbose!(hash);
  if (blockCache.size >= BLOCK_CACHE_MAX) {
    blockCache.delete(blockCache.keys().next().value!);
  }
  blockCache.set(hash, block);
  return block;
};

/**
 * Depth of the confirmed spend of `txid:vout` on the other chain if it lies
 * within the last `window` blocks, or undefined when it is deeper than that.
 * Only called once gettxout has shown the output is spent in a confirmed
 * block, so not finding it near the tip means it is at least `window` deep.
 */
const recentSpendDepth = async (
  other: IChainClient,
  txid: string,
  vout: number,
  window: number,
): Promise<number | undefined> => {
  const client = other as Partial<ChainClient>;
  if (client.getBlockVerbose === undefined) {
    throw new ChainIdentityError(
      `${other.symbol} node: cannot read blocks to check how deep a conflicting spend is`,
    );
  }
  const { blocks: tip } = await other.getBlockchainInfo();
  for (let depth = 1; depth <= window && tip - depth + 1 >= 0; depth++) {
    const block = await cachedBlock(
      client,
      await other.getBlockhash(tip - depth + 1),
    );
    const spends = block.tx.some((t) =>
      t.vin.some((i) => i.txid === txid && i.vout === vout),
    );
    if (spends) return depth;
  }
  return undefined;
};

/**
 * Whether `tx` can never be valid on the other chain: one of its inputs
 * exists in a confirmed block there and is already spent there, `tx` itself
 * is not on that chain, so something else spent it. That spend must be at
 * least `depth` blocks deep, or a reorg could undo it; a shallower one gives
 * 'shallow' (shared for now). Undefined when no input conflicts. Fails
 * closed on any lookup error other than "not found".
 */
export const conflictOnOther = async (
  other: IChainClient,
  tx: RawTransaction,
  depth = conflictDepth,
): Promise<{ verdict: Uniqueness; reason: string } | undefined> => {
  const rpc = (other as Partial<ChainClient>).rpc;
  if (rpc === undefined) return undefined;

  if ((await fetchOnOther(other, tx.txid)) !== undefined) return undefined;

  let shallow: string | undefined;
  for (const input of tx.vin) {
    let unspent: unknown;
    try {
      // Confirmed blocks only: a mempool spend there proves nothing
      unspent = await rpc.call(other, 'gettxout', [
        input.txid,
        input.vout,
        false,
      ]);
    } catch (error) {
      if (errorText(error) !== NO_RESULT_RPC) {
        throw new ChainIdentityError(
          `${other.symbol} node: gettxout ${input.txid}:${input.vout} failed: ${errorText(error)}`,
        );
      }
      unspent = null;
    }
    if (unspent !== null && unspent !== undefined) continue;

    const parent = await fetchOnOther(other, input.txid);
    if (
      parent === undefined ||
      parent.confirmations === undefined ||
      parent.confirmations <= 0
    ) {
      continue;
    }

    const found = await recentSpendDepth(
      other,
      input.txid,
      input.vout,
      depth - 1,
    );
    if (found === undefined) {
      return {
        verdict: 'unique',
        reason: `${tx.txid} spends ${input.txid}:${input.vout}, which the ${other.symbol} chain already spent in a different transaction at least ${depth} blocks deep`,
      };
    }
    shallow ??= `${tx.txid} conflicts with a spend of ${input.txid}:${input.vout} on the ${other.symbol} chain that is only ${found} block(s) deep; needs ${depth} before the split is trusted`;
  }

  return shallow === undefined
    ? undefined
    : { verdict: 'shared', reason: shallow };
};

export const classifyCoin = async (
  client: IChainClient,
  forkHeight: number,
  tip: number,
  txid: string,
  options: Options,
  memo = new Map<string, Verdict>(),
  visits = { count: 0 },
): Promise<Verdict> => {
  const known = memo.get(txid);
  if (known !== undefined) return known;

  if (++visits.count > (options.maxVisits ?? 5_000)) {
    throw new ChainIdentityError(
      `${client.symbol} wallet: coin ancestry is longer than ${options.maxVisits ?? 5_000} transactions; cannot prove it exists on this chain only`,
    );
  }

  let tx: RawTransaction;
  try {
    tx = await client.getRawTransactionVerbose(txid);
  } catch (error) {
    throw new ChainIdentityError(
      `${client.symbol} wallet: cannot fetch ancestor ${txid} to check it against the fork (is txindex=1 set?): ${(error as Error).message ?? error}`,
    );
  }

  const height =
    tx.confirmations !== undefined && tx.confirmations > 0
      ? tip - tx.confirmations + 1
      : undefined;

  let result: Verdict;
  if (height !== undefined && height < forkHeight) {
    result = {
      verdict: 'shared',
      reason: `ancestor ${txid} confirmed at ${height}, before the fork`,
    };
  } else if (isCoinbase(tx)) {
    result = {
      verdict: 'unique',
      reason: `post-fork coinbase ${txid}`,
    };
  } else if (options.isBlake2b && optsIn(tx)) {
    result = {
      verdict: 'unique',
      reason: `${txid} is signed with SIGHASH_UNIFIED`,
    };
  } else {
    result = {
      verdict: 'shared',
      reason: `${txid} spends only shared coins without SIGHASH_UNIFIED, so it can be replayed`,
    };
    for (const input of tx.vin) {
      const parent = await classifyCoin(
        client,
        forkHeight,
        tip,
        input.txid,
        options,
        memo,
        visits,
      );
      if (parent.verdict === 'unique') {
        result = parent;
        break;
      }
    }
    let shallowSplit = false;
    if (result.verdict === 'shared' && options.other !== undefined) {
      const conflict = await conflictOnOther(
        options.other,
        tx,
        options.minConflictDepth ?? conflictDepth,
      );
      if (conflict !== undefined) {
        result = conflict;
        shallowSplit = conflict.verdict === 'shared';
      }
    }
    if (result.verdict === 'shared' && !shallowSplit) {
      // Name the root cause only: nesting every hop grows without bound
      const first = memo.get(tx.vin[0].txid);
      if (first !== undefined) {
        result = {
          verdict: 'shared',
          reason: first.reason.startsWith('ancestor ')
            ? first.reason
            : `${txid} spends shared coins without SIGHASH_UNIFIED`,
        };
      }
    }
  }

  memo.set(txid, result);
  return result;
};

// RpcClient rejects a null result with this string; gettxout answers null
// for "no such unspent output", which is the answer we hope for.
const NO_RESULT = 'no result in RPC response';

const gettxout = async (
  rpc: NonNullable<Partial<ChainClient>['rpc']>,
  other: IChainClient,
  txid: string,
  vout: number,
): Promise<unknown> => {
  try {
    return await rpc.call(other, 'gettxout', [txid, vout, true]);
  } catch (error) {
    if (error === NO_RESULT || (error as Error)?.message === NO_RESULT) {
      return null;
    }
    throw error;
  }
};

/**
 * Refuse to start when any confirmed coin in `client`'s wallet could also
 * exist on `other`'s chain. Unconfirmed coins are checked too: an incoming
 * deposit is unconfirmed at first, and skipping it would let the guard pass
 * an empty-looking wallet whose coins then confirm unchecked. The walk
 * handles them (no height yet, so it goes straight to the inputs).
 */
export const verifyProviderCoins = async (
  client: IChainClient,
  other: IChainClient,
  forkHeight: number,
  options: Options,
): Promise<string> => {
  const [utxos, info] = await Promise.all([
    client.listUnspent(0),
    client.getBlockchainInfo(),
  ]);
  const tip = info.blocks;
  const memo = seededMemo(client.symbol);
  const visits = { count: 0 };

  // Every Core-backed client has rpc(); a mock in a unit test may not
  const rpc = (other as Partial<ChainClient>).rpc;

  for (const utxo of utxos) {
    const outpoint = `${utxo.txid}:${utxo.vout}`;

    if (rpc !== undefined) {
      const there = await gettxout(rpc, other, utxo.txid, utxo.vout);
      if (there !== null && there !== undefined) {
        throw new ChainIdentityError(
          `${client.symbol} wallet coin ${outpoint} (${utxo.amount}) also exists on the ${other.symbol} chain. Move it out or fund a fresh wallet with coins unique to this chain.`,
        );
      }
    }

    const { verdict, reason } = await classifyCoin(
      client,
      forkHeight,
      tip,
      utxo.txid,
      options,
      memo,
      visits,
    );
    if (verdict === 'shared') {
      throw new ChainIdentityError(
        `${client.symbol} wallet coin ${outpoint} (${utxo.amount}) can exist on the ${other.symbol} chain too: ${reason}. Move it out or fund a fresh wallet with coins unique to this chain.`,
      );
    }
  }

  rememberUnique(client.symbol, memo);
  return `${client.symbol} wallet: ${utxos.length} coin(s), all unique to this chain (fork at ${forkHeight}, ${visits.count} transaction(s) checked)`;
};

/**
 * 'unique' verdicts per chain, kept between checks. They do not change once
 * reached (a post-fork coinbase, a SIGHASH_UNIFIED signature, or a
 * conflicting spend already buried past the reorg depth), so each lockup only
 * walks coins it has not seen. 'shared' verdicts are never kept: a shallow
 * split can become unique later.
 */
const uniqueByChain = new Map<string, Map<string, Verdict>>();

const seededMemo = (symbol: string) =>
  new Map<string, Verdict>(uniqueByChain.get(symbol) ?? []);

const rememberUnique = (symbol: string, memo: Map<string, Verdict>) => {
  let known = uniqueByChain.get(symbol);
  if (known === undefined) {
    known = new Map();
    uniqueByChain.set(symbol, known);
  }
  for (const [txid, verdict] of memo) {
    if (verdict.verdict === 'unique') known.set(txid, verdict);
  }
};

/** Test hook: forget every remembered verdict. */
export const resetUniqueCache = () => uniqueByChain.clear();

export type Quarantined = { outpoint: string; amount: number; reason: string };

/**
 * D26 at lockup time. The startup guard only sees the wallet as it was at
 * startup: a deposit, or a coin unlocked, while the backend runs would be
 * spent unchecked. Run this right before every server lockup. Any coin that
 * can also exist on the other chain is locked in the wallet (persistently),
 * so the lockup that follows cannot select it; the caller logs it for the
 * operator. Lookup failures throw (fail closed), and the caller then refuses
 * the lockup.
 */
export const quarantineSharedCoins = async (
  client: IChainClient,
  other: IChainClient,
  forkHeight: number,
  options: Options,
): Promise<{ checked: number; quarantined: Quarantined[] }> => {
  const [utxos, info] = await Promise.all([
    client.listUnspent(0),
    client.getBlockchainInfo(),
  ]);
  const memo = seededMemo(client.symbol);
  const visits = { count: 0 };
  const rpcOther = (other as Partial<ChainClient>).rpc;
  const quarantined: Quarantined[] = [];

  for (const utxo of utxos) {
    const outpoint = `${utxo.txid}:${utxo.vout}`;
    if (rpcOther !== undefined) {
      const there = await gettxout(rpcOther, other, utxo.txid, utxo.vout);
      if (there !== null && there !== undefined) {
        quarantined.push({
          outpoint,
          amount: utxo.amount,
          reason: `also exists on the ${other.symbol} chain`,
        });
        continue;
      }
    }
    const { verdict, reason } = await classifyCoin(
      client,
      forkHeight,
      info.blocks,
      utxo.txid,
      options,
      memo,
      visits,
    );
    if (verdict === 'shared') {
      quarantined.push({ outpoint, amount: utxo.amount, reason });
    }
  }
  rememberUnique(client.symbol, memo);

  if (quarantined.length > 0) {
    // lockunspent is a wallet method: it must go to /wallet/<name>, because
    // a node with several wallets loaded refuses it on the node path
    const walletRpc = (client as Partial<ChainClient>).walletRpc;
    if (walletRpc === undefined) {
      throw new ChainIdentityError(
        `${client.symbol} wallet: cannot lock ${quarantined.length} shared coin(s)`,
      );
    }
    const coins = quarantined.map((q) => {
      const [txid, vout] = q.outpoint.split(':');
      return { txid, vout: Number(vout) };
    });
    try {
      await walletRpc.call(client, 'lockunspent', [false, coins, true]);
    } catch (persistentError) {
      // Older nodes have no persistent flag; an in-memory lock still covers
      // this lockup, and the next check locks the coin again
      try {
        await walletRpc.call(client, 'lockunspent', [false, coins]);
      } catch (error) {
        throw new ChainIdentityError(
          `${client.symbol} wallet: lockunspent failed: ${errorText(persistentError)}; without the persistent flag: ${errorText(error)}`,
        );
      }
    }
  }

  return { checked: visits.count, quarantined };
};
