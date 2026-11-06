import { sha256 } from '@noble/hashes/sha2.js';
import type ChainClient from '../chain/ChainClient';
import type { IChainClient } from '../chain/ChainClient';
import type { RawTransaction, Transaction } from '../consts/Types';
import { filterMatchesAny, spentScripts } from './BlockFilter';
import { ChainIdentityError } from './ChainIdentity';

/**
 * No source has the transaction, so a verdict cannot be proven. Callers that
 * walk several inputs can still prove a coin unique through another input; a
 * wallet coin left unprovable is locked, not spent (D38 S3).
 */
export class UnprovableError extends ChainIdentityError {}

/**
 * D38: finding transactions on a node that has no txindex.
 *
 * The SHA-256 Companion on StartOS is pruned and cannot run txindex, so
 * `getrawtransaction <txid>` only answers for the mempool. Its RPC proxy does
 * serve any block, pruned or not, once it is asked by hash (V1, Nov 5). So the
 * missing piece is which block a transaction is in. This module finds that
 * out from sources a pruned node still has, and only then fetches by hash:
 *
 *   - the wallet (`gettransaction`): SwapSha's own transactions
 *   - transactions SwapSha has already seen (the sidecar's relevant
 *     transactions and every broadcast), kept in memory with their block
 *   - an output that is still unspent (`gettxout` gives its height)
 *   - the block of a transaction that spends it: that block's undo data
 *     (`getblock <hash> 3`) gives the height every input was created at
 *   - for the replay guards only: the other chain, which shares this chain's
 *     history before the fork and runs txindex (the archival BLAKE2b node)
 *   - last, BIP158 block filters: the script the spender's input spent
 *     narrows the search to the few blocks whose filter matches it
 *
 * Nothing found is taken on trust: a transaction fetched by block hash must
 * hash to the txid that was asked for. When no source answers, the caller
 * fails closed, as it did with txindex missing before.
 */

const errorText = (error: unknown) =>
  typeof error === 'string' ? error : ((error as Error)?.message ?? `${error}`);

/**
 * Errors that mean "this node does not have it", as opposed to a node that is
 * broken or unreachable. Only these move on to the next source.
 */
const NOT_HERE =
  /No such mempool or blockchain transaction|No such mempool transaction|No such transaction found|Use -txindex|Invalid or non-wallet transaction id|Block not available|pruned data|Block not found|Transaction not found|no result in RPC response/i;

export const isNotHere = (error: unknown): boolean =>
  NOT_HERE.test(errorText(error));

/* ---------- txid of a raw transaction ---------- */

const varint = (b: Uint8Array, i: number): [number, number] => {
  const n = b[i];
  if (n < 0xfd) return [n, i + 1];
  const view = new DataView(b.buffer, b.byteOffset + i + 1);
  if (n === 0xfd) return [view.getUint16(0, true), i + 3];
  if (n === 0xfe) return [view.getUint32(0, true), i + 5];
  return [Number(view.getBigUint64(0, true)), i + 9];
};

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/**
 * The txid of a raw transaction: double SHA-256 of its serialization without
 * witness data, byte-reversed. Throws on a malformed transaction.
 */
export const txidOfHex = (hex: string): string => {
  const b = Uint8Array.from(Buffer.from(hex, 'hex'));
  let i = 4;
  const segwit = b[i] === 0 && b[i + 1] !== 0;
  if (segwit) i += 2;
  const bodyStart = i;
  let n: number;
  [n, i] = varint(b, i);
  const inputs = n;
  for (let k = 0; k < inputs; k++) {
    i += 36;
    let len: number;
    [len, i] = varint(b, i);
    i += len + 4;
  }
  [n, i] = varint(b, i);
  for (let k = 0; k < n; k++) {
    i += 8;
    let len: number;
    [len, i] = varint(b, i);
    i += len;
  }
  const bodyEnd = i;
  if (segwit) {
    for (let k = 0; k < inputs; k++) {
      let items: number;
      [items, i] = varint(b, i);
      for (let m = 0; m < items; m++) {
        let len: number;
        [len, i] = varint(b, i);
        i += len;
      }
    }
  }
  if (i + 4 !== b.length) {
    throw new Error(
      `malformed transaction: parsed ${i + 4} of ${b.length} bytes`,
    );
  }
  const stripped = new Uint8Array(4 + (bodyEnd - bodyStart) + 4);
  stripped.set(b.subarray(0, 4), 0);
  stripped.set(b.subarray(bodyStart, bodyEnd), 4);
  stripped.set(b.subarray(i, i + 4), 4 + (bodyEnd - bodyStart));
  return toHex(sha256(sha256(stripped)).reverse());
};

/* ---------- transactions SwapSha has seen ---------- */

type Known = { hex: string; blockhash?: string };

const MAX_KNOWN_PER_CHAIN = 50_000;
const known = new Map<string, Map<string, Known>>();

/**
 * Keep a transaction SwapSha has seen (a relevant transaction from the
 * sidecar, or one it broadcast), so a later lookup on a node without txindex
 * can still find it. Returns its txid.
 */
export const rememberTransaction = (
  symbol: string,
  hex: string,
  blockhash?: string,
): string => {
  const txid = txidOfHex(hex);
  let chain = known.get(symbol);
  if (chain === undefined) {
    chain = new Map();
    known.set(symbol, chain);
  }
  const before = chain.get(txid);
  chain.delete(txid);
  chain.set(txid, { hex, blockhash: blockhash ?? before?.blockhash });
  if (chain.size > MAX_KNOWN_PER_CHAIN) {
    chain.delete(chain.keys().next().value!);
  }
  return txid;
};

export const knownTransaction = (
  symbol: string,
  txid: string,
): Known | undefined => known.get(symbol)?.get(txid);

/** Test hook */
export const resetKnownTransactions = () => known.clear();

/* ---------- node helpers ---------- */

type Rpc = <T>(method: string, params?: unknown[]) => Promise<T>;

const rpcOf = (client: IChainClient): Rpc | undefined => {
  const rpc = (client as Partial<ChainClient>).rpc;
  return rpc === undefined
    ? undefined
    : <T>(method: string, params?: unknown[]) => rpc<T>(method, params);
};

/** getrawtransaction <txid> 1 <blockhash>; on a pruned node without a proxy,
 * ask a peer for the block first (getblockfrompeer) and try again. */
const inBlock = async (
  client: IChainClient,
  txid: string,
  blockhash: string,
): Promise<RawTransaction | undefined> => {
  const rpc = rpcOf(client);
  if (rpc === undefined) return undefined;

  const read = () =>
    rpc<RawTransaction & { in_active_chain?: boolean }>('getrawtransaction', [
      txid,
      1,
      blockhash,
    ]);

  let tx: (RawTransaction & { in_active_chain?: boolean }) | undefined;
  try {
    tx = await read();
  } catch (error) {
    if (!/Block not available|pruned/i.test(errorText(error))) {
      if (isNotHere(error)) return undefined;
      throw error;
    }
    if (!(await fetchBlockFromPeer(rpc, blockhash))) return undefined;
    try {
      tx = await read();
    } catch (retry) {
      if (isNotHere(retry)) return undefined;
      throw retry;
    }
  }

  if (tx.in_active_chain === false) return undefined;
  // Fetched from a peer or through a proxy: check it is what was asked for
  if (txidOfHex(tx.hex) !== txid) {
    throw new ChainIdentityError(
      `${client.symbol} node returned a transaction for ${txid} in block ${blockhash} that does not hash to it`,
    );
  }
  return tx;
};

const PEER_FETCH_WAIT_MS = 15_000;

/** True once the block is on disk again. Needs a peer that has it. */
const fetchBlockFromPeer = async (rpc: Rpc, blockhash: string) => {
  let peers: { id: number; servicesnames?: string[] }[];
  try {
    peers = await rpc('getpeerinfo');
  } catch {
    return false;
  }
  const full = peers.filter((p) => p.servicesnames?.includes('NETWORK'));
  for (const peer of full.length > 0 ? full : peers) {
    try {
      await rpc('getblockfrompeer', [blockhash, peer.id]);
    } catch {
      continue;
    }
    for (let waited = 0; waited < PEER_FETCH_WAIT_MS; waited += 250) {
      try {
        await rpc('getblock', [blockhash, 0]);
        return true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  return false;
};

const heightToHash = async (client: IChainClient, height: number) => {
  try {
    return await client.getBlockhash(height);
  } catch {
    return undefined;
  }
};

/** Height of an output that is still unspent in the confirmed UTXO set. */
const unspentHeight = async (
  client: IChainClient,
  txid: string,
  vout: number,
): Promise<number | undefined> => {
  const rpc = rpcOf(client);
  if (rpc === undefined) return undefined;
  try {
    const [coin, info] = await Promise.all([
      // false: ignore mempool spends, so a coin a pending tx spends still shows
      rpc<{ confirmations: number } | null>('gettxout', [txid, vout, false]),
      client.getBlockchainInfo(),
    ]);
    if (coin === null || coin === undefined || !(coin.confirmations > 0)) {
      return undefined;
    }
    return info.blocks - coin.confirmations + 1;
  } catch {
    return undefined;
  }
};

type UndoBlock = {
  tx: { txid: string; vin: { prevout?: { height: number } }[] }[];
};

const undoCache = new Map<string, UndoBlock>();
const UNDO_CACHE_MAX = 8;

/** Height input `input` of `childTxid` spends from, from the block's undo data. */
const prevoutHeight = async (
  client: IChainClient,
  child: { txid: string; blockhash?: string; input: number },
): Promise<number | undefined> => {
  if (child.blockhash === undefined) return undefined;
  const rpc = rpcOf(client);
  if (rpc === undefined) return undefined;
  let block = undoCache.get(child.blockhash);
  if (block === undefined) {
    try {
      block = await rpc<UndoBlock>('getblock', [child.blockhash, 3]);
    } catch {
      // Undo data is pruned with the block, and a proxy-fetched block has none
      return undefined;
    }
    if (undoCache.size >= UNDO_CACHE_MAX) {
      undoCache.delete(undoCache.keys().next().value!);
    }
    undoCache.set(child.blockhash, block);
  }
  return block.tx.find((t) => t.txid === child.txid)?.vin[child.input]?.prevout
    ?.height;
};

/** A wallet transaction, in the shape getrawtransaction would give. */
const fromWallet = async (
  client: IChainClient,
  txid: string,
): Promise<RawTransaction | undefined> => {
  const rpc = rpcOf(client);
  if (rpc === undefined || typeof client.getWalletTransaction !== 'function') {
    return undefined;
  }
  let w: { hex: string; blockhash?: string; confirmations?: number };
  try {
    w = (await client.getWalletTransaction(txid)) as typeof w;
  } catch {
    return undefined;
  }
  if (w?.hex === undefined || txidOfHex(w.hex) !== txid) return undefined;
  if (w.blockhash !== undefined && (w.confirmations ?? 0) > 0) {
    const confirmed = await inBlock(client, txid, w.blockhash);
    if (confirmed !== undefined) return confirmed;
  }
  return await decoded(client, w.hex, w.confirmations);
};

const decoded = async (
  client: IChainClient,
  hex: string,
  confirmations?: number,
): Promise<RawTransaction | undefined> => {
  const rpc = rpcOf(client);
  if (rpc === undefined) return undefined;
  try {
    const tx = await rpc<Transaction>('decoderawtransaction', [hex]);
    return {
      ...tx,
      hex,
      confirmations:
        confirmations !== undefined && confirmations > 0
          ? confirmations
          : undefined,
      time: 0,
      blocktime: 0,
    };
  } catch {
    return undefined;
  }
};

/* ---------- the lookups ---------- */

export type FetchHints = {
  /**
   * Replay guards only: the other chain. It shares this chain's history
   * before the fork and runs txindex, so a transaction it has is shared
   * history and its copy answers just as well.
   */
  oracle?: IChainClient;
  /** The transaction that spends this one, and which of its inputs does */
  child?: {
    txid: string;
    blockhash?: string;
    input: number;
    /** Height of the child's block: this transaction is at or below it */
    height?: number;
    /** That input, for the script it spent (block filter search) */
    spends?: { scriptSig?: { hex?: string }; txinwitness?: string[] };
  };
  /** An output of this transaction that may still be unspent */
  vout?: number;
  /** Lowest height worth searching (the fork, for SHA-256-only history) */
  floor?: number;
};

/** Blocks to try around a height worked out from a tip that may have moved */
const nearby = (height: number) => [height, height - 1, height + 1];

/**
 * A copy of `txid` from this chain's own sources, without txindex: the
 * wallet, transactions already seen, and block heights from unspent outputs
 * or the spender's undo data. Undefined when none has it.
 */
export const localCopy = async (
  client: IChainClient,
  txid: string,
  hints: FetchHints = {},
): Promise<RawTransaction | undefined> => {
  const wallet = await fromWallet(client, txid);
  if (wallet?.confirmations !== undefined) return wallet;

  const seen = knownTransaction(client.symbol, txid);
  if (seen?.blockhash !== undefined) {
    const tx = await inBlock(client, txid, seen.blockhash);
    if (tx !== undefined) return tx;
  }

  const heights: number[] = [];
  if (hints.vout !== undefined) {
    const h = await unspentHeight(client, txid, hints.vout);
    if (h !== undefined) heights.push(h);
  }
  if (heights.length === 0 && seen !== undefined) {
    // Any output of a transaction we have seen that is still unspent
    const tx = await decoded(client, seen.hex);
    for (const output of tx?.vout ?? []) {
      const h = await unspentHeight(client, txid, output.n);
      if (h !== undefined) {
        heights.push(h);
        break;
      }
    }
  }
  if (heights.length === 0 && hints.child !== undefined) {
    const h = await prevoutHeight(client, hints.child);
    if (h !== undefined) heights.push(h);
  }

  for (const height of heights.flatMap(nearby)) {
    const hash = await heightToHash(client, height);
    if (hash === undefined) continue;
    const tx = await inBlock(client, txid, hash);
    if (tx !== undefined) {
      rememberTransaction(client.symbol, tx.hex, hash);
      return tx;
    }
  }

  // Seen, or in the wallet, but not confirmed (or its block not found)
  return wallet ?? (seen === undefined ? undefined : decoded(client, seen.hex));
};

/** Filters per block hash; a filter never changes for a given block */
const filterCache = new Map<string, string>();
const FILTER_CACHE_MAX = 4_000;
/** At most this many blocks are searched for one transaction */
export const MAX_FILTER_SCAN = 50_000;
const FILTER_BATCH = 25;

/**
 * Search the BIP158 filters from the spender's block down to `floor` for the
 * block that created the output the spender's input spent, then read the
 * transaction from it by hash. Needs `blockfilterindex` on the node;
 * undefined when it is off or nothing matches. Costly, so it runs last.
 */
export const scanFilters = async (
  client: IChainClient,
  txid: string,
  hints: FetchHints,
): Promise<RawTransaction | undefined> => {
  const spends = hints.child?.spends;
  const rpc = rpcOf(client);
  if (spends === undefined || rpc === undefined) return undefined;
  const scripts = spentScripts(spends);
  if (scripts.length === 0) return undefined;

  let top: number;
  try {
    top = hints.child?.height ?? (await client.getBlockchainInfo()).blocks;
  } catch {
    return undefined;
  }
  const floor = Math.max(hints.floor ?? 0, top - MAX_FILTER_SCAN);

  const filterAt = async (height: number) => {
    const hash = await heightToHash(client, height);
    if (hash === undefined) return undefined;
    let filter = filterCache.get(hash);
    if (filter === undefined) {
      // Throws when the node has no block filter index: the search stops
      filter = (
        await rpc<{ filter: string }>('getblockfilter', [hash, 'basic'])
      ).filter;
      if (filterCache.size >= FILTER_CACHE_MAX) {
        filterCache.delete(filterCache.keys().next().value!);
      }
      filterCache.set(hash, filter);
    }
    return filterMatchesAny(filter, hash, scripts) ? hash : undefined;
  };

  try {
    for (let high = top; high >= floor; high -= FILTER_BATCH) {
      const heights: number[] = [];
      for (let h = high; h > high - FILTER_BATCH && h >= floor; h--) {
        heights.push(h);
      }
      const matches = await Promise.all(heights.map(filterAt));
      for (const hash of matches) {
        if (hash === undefined) continue;
        const tx = await inBlock(client, txid, hash);
        if (tx !== undefined) {
          rememberTransaction(client.symbol, tx.hex, hash);
          return tx;
        }
      }
    }
  } catch (error) {
    if (error instanceof ChainIdentityError) throw error;
    return undefined;
  }
  return undefined;
};

/** Confirmations of the oracle's copy, restated against `client`'s tip. */
const restate = async (
  client: IChainClient,
  oracle: IChainClient,
  tx: RawTransaction,
): Promise<RawTransaction> => {
  if (tx.confirmations === undefined || tx.confirmations <= 0) {
    return { ...tx, blockhash: undefined };
  }
  const [own, theirs] = await Promise.all([
    client.getBlockchainInfo(),
    oracle.getBlockchainInfo(),
  ]);
  const height = theirs.blocks - tx.confirmations + 1;
  return {
    ...tx,
    // The other chain's block: not a block of this chain after the fork
    blockhash: undefined,
    confirmations: own.blocks - height + 1,
  };
};

/**
 * `txid` for the replay guards' ancestry walk on `client`'s chain. Tries the
 * node first (mempool, or txindex where there is one), then, only when the
 * node says it does not have it: this chain's own sources (localCopy), then
 * the oracle. Throws when nothing has it, so the guard fails closed.
 */
export const fetchTransaction = async (
  client: IChainClient,
  txid: string,
  hints: FetchHints = {},
): Promise<RawTransaction> => {
  let nodeError: unknown;
  try {
    return await client.getRawTransactionVerbose(txid);
  } catch (error) {
    if (!isNotHere(error)) throw error;
    nodeError = error;
  }

  const local = await localCopy(client, txid, hints);
  if (local?.confirmations !== undefined) return local;

  if (hints.oracle !== undefined) {
    try {
      const shared = await hints.oracle.getRawTransactionVerbose(txid);
      return await restate(client, hints.oracle, shared);
    } catch (error) {
      if (!isNotHere(error)) throw error;
    }
  }

  const found = await scanFilters(client, txid, hints);
  if (found !== undefined) return found;

  if (local !== undefined) return local;

  throw new UnprovableError(
    `${client.symbol} node has no txindex and SwapSha found no copy of ${txid} (D38: not in the wallet, not seen before, no block hint${hints.oracle === undefined ? '' : `, not on the ${hints.oracle.symbol} chain`}, no block filter match): ${errorText(nodeError)}`,
  );
};
