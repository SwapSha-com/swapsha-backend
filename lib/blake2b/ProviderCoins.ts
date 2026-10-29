import type ChainClient from '../chain/ChainClient';
import type { IChainClient } from '../chain/ChainClient';
import type { RawTransaction } from '../consts/Types';
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
    if (result.verdict === 'shared') {
      // Name the root cause, not just the last hop
      const first = memo.get(tx.vin[0].txid);
      if (first !== undefined) {
        result = {
          verdict: 'shared',
          reason: `${txid} spends shared coins without SIGHASH_UNIFIED (${first.reason})`,
        };
      }
    }
  }

  memo.set(txid, result);
  return result;
};

/**
 * Refuse to start when any confirmed coin in `client`'s wallet could also
 * exist on `other`'s chain. Unconfirmed outputs are skipped: they can only
 * spend coins the wallet already holds, and those are checked.
 */
export const verifyProviderCoins = async (
  client: IChainClient,
  other: IChainClient,
  forkHeight: number,
  options: Options,
): Promise<string> => {
  const [utxos, info] = await Promise.all([
    client.listUnspent(1),
    client.getBlockchainInfo(),
  ]);
  const tip = info.blocks;
  const memo = new Map<string, Verdict>();
  const visits = { count: 0 };

  // Every Core-backed client has rpc(); a mock in a unit test may not
  const rpc = (other as Partial<ChainClient>).rpc;

  for (const utxo of utxos) {
    const outpoint = `${utxo.txid}:${utxo.vout}`;

    if (rpc !== undefined) {
      const there = await rpc.call(other, 'gettxout', [
        utxo.txid,
        utxo.vout,
        true,
      ]);
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

  return `${client.symbol} wallet: ${utxos.length} confirmed coin(s), all unique to this chain (fork at ${forkHeight}, ${visits.count} transaction(s) checked)`;
};
