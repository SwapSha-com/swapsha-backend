import { SwapTreeSerializer } from 'boltz-core';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { parseTransaction } from '../Core';
import type Logger from '../Logger';
import { TxView } from '../TxView';
import { formatError } from '../Utils';
import {
  CurrencyType,
  FinalChainSwapEvents,
  FinalReverseSwapEvents,
  FinalSwapEvents,
  SwapUpdateEvent,
} from '../consts/Enums';
import type { ChainSwapInfo } from '../db/repositories/ChainSwapRepository';
import ChainSwapRepository from '../db/repositories/ChainSwapRepository';
import ReverseSwapRepository from '../db/repositories/ReverseSwapRepository';
import SwapRepository from '../db/repositories/SwapRepository';
import type { Currency } from '../wallet/WalletManager';

/**
 * SwapSha D44 (third amendment, Nov 10): the backend learns of a rescue.
 *
 * The package's Rescue Swap action signs a refund of SwapSha's lockup, or a
 * claim of the user's, while the backend is stopped, and records what it
 * signed in rescued.json in the data directory. Without this the swap stays
 * open: the backend tries its own refund of the spent lockup at every block,
 * and a type 2 hold invoice stays accepted until the Lightning node cancels
 * it near the HTLC's expiry.
 *
 * At startup and on every block, each record whose swap is still open is
 * checked against that swap alone: the transaction must have the recorded
 * id, spend the swap's lockup by its refund leaf (or its claim leaf with the
 * swap's preimage), and be confirmed. Then the swap is marked refunded or
 * claimed with it, exactly as if the backend had sent it. Anything else is
 * logged and left alone: taking a user's claim for a rescue would make
 * SwapSha skip its own claim.
 */

export const rescuedFileName = 'rescued.json';

export type RescueRecord = {
  id: string;
  kind: 'refund' | 'claim';
  txid: string;
  hex: string;
};

/** The lockup a record is about, from the swap's own data */
export type RescuedLockup = {
  symbol: string;
  transactionId: string;
  vout: number;
  amount: number;
  swapTree: string;
  preimageHash: string;
};

export type RescueCheck =
  | { ok: true; vin: number; minerFee: number; preimage?: Buffer }
  | { ok: false; reason: string };

const sha256Hex = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array) =>
  a !== undefined && Buffer.from(a).equals(Buffer.from(b));

/** Whether `record` spends `lockup` as a rescue of that kind; no node needed */
export const checkRescueSpend = (
  record: RescueRecord,
  lockup: RescuedLockup,
): RescueCheck => {
  let tx: TxView;
  try {
    tx = TxView.of(parseTransaction(CurrencyType.BitcoinLike, record.hex));
  } catch (error) {
    return { ok: false, reason: `not a transaction: ${formatError(error)}` };
  }
  if (tx.id !== record.txid) {
    return { ok: false, reason: `its id is ${tx.id}, not ${record.txid}` };
  }

  const vin = tx.inputs.findIndex(
    (input) =>
      input.txid === lockup.transactionId && input.index === lockup.vout,
  );
  if (vin === -1) {
    return {
      ok: false,
      reason: `it does not spend the lockup ${lockup.transactionId}:${lockup.vout}`,
    };
  }

  const witness = tx.inputs[vin].witness ?? [];
  const tree = SwapTreeSerializer.deserializeSwapTree(lockup.swapTree);
  const paid = tx.outputs.reduce((sum, o) => sum + (o.amount ?? 0n), 0n);
  const minerFee = Math.max(0, lockup.amount - Number(paid));

  if (record.kind === 'refund') {
    // Signature, refund leaf, control block
    if (
      witness.length !== 3 ||
      !sameBytes(witness[1], tree.refundLeaf.output)
    ) {
      return {
        ok: false,
        reason: 'it does not spend the lockup by its refund leaf',
      };
    }
    return { ok: true, vin, minerFee };
  }

  // Signature, preimage, claim leaf, control block
  if (witness.length !== 4 || !sameBytes(witness[2], tree.claimLeaf.output)) {
    return {
      ok: false,
      reason: 'it does not spend the lockup by its claim leaf',
    };
  }
  if (sha256Hex(witness[1]) !== lockup.preimageHash) {
    return { ok: false, reason: "its preimage does not match the swap's" };
  }
  return { ok: true, vin, minerFee, preimage: Buffer.from(witness[1]) };
};

export const readRescueRecords = (dataDir: string): RescueRecord[] => {
  const file = path.join(dataDir, rescuedFileName);
  if (!fs.existsSync(file)) {
    return [];
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    rescues?: unknown;
  };
  if (!Array.isArray(parsed.rescues)) {
    throw new Error(`${file} has no list of rescues`);
  }
  return parsed.rescues.filter(
    (r): r is RescueRecord =>
      typeof r === 'object' &&
      r !== null &&
      typeof r.id === 'string' &&
      (r.kind === 'refund' || r.kind === 'claim') &&
      typeof r.txid === 'string' &&
      typeof r.hex === 'string',
  );
};

type OpenSwap =
  | { kind: 'chain'; swap: ChainSwapInfo }
  | {
      kind: 'reverse';
      swap: NonNullable<
        Awaited<ReturnType<typeof ReverseSwapRepository.getReverseSwap>>
      >;
    }
  | {
      kind: 'submarine';
      swap: NonNullable<Awaited<ReturnType<typeof SwapRepository.getSwap>>>;
    };

const findOpenSwap = async (id: string): Promise<OpenSwap | undefined> => {
  const chain = await ChainSwapRepository.getChainSwap({ id });
  if (chain !== null) {
    return FinalChainSwapEvents.includes(chain.status as SwapUpdateEvent)
      ? undefined
      : { kind: 'chain', swap: chain };
  }
  const reverse = await ReverseSwapRepository.getReverseSwap({ id });
  if (reverse !== null) {
    return FinalReverseSwapEvents.includes(reverse.status as SwapUpdateEvent)
      ? undefined
      : { kind: 'reverse', swap: reverse };
  }
  const submarine = await SwapRepository.getSwap({ id });
  if (submarine !== null) {
    return FinalSwapEvents.includes(submarine.status as SwapUpdateEvent)
      ? undefined
      : { kind: 'submarine', swap: submarine };
  }
  return undefined;
};

/** The lockup a record of `kind` spends in `open`, if it has one */
const lockupOf = (
  open: OpenSwap,
  kind: RescueRecord['kind'],
): RescuedLockup | undefined => {
  const lockup = (
    symbol: string,
    transactionId: string | null | undefined,
    vout: number | null | undefined,
    amount: number | null | undefined,
    swapTree: string | null | undefined,
    preimageHash: string,
  ) =>
    transactionId && vout !== null && vout !== undefined && swapTree
      ? {
          symbol,
          transactionId,
          vout,
          amount: Number(amount ?? 0),
          swapTree,
          preimageHash,
        }
      : undefined;

  if (open.kind === 'chain') {
    const data =
      kind === 'refund' ? open.swap.sendingData : open.swap.receivingData;
    return lockup(
      data.symbol,
      data.transactionId,
      data.transactionVout,
      data.amount ?? data.expectedAmount,
      data.swapTree,
      open.swap.preimageHash,
    );
  }
  if (open.kind === 'reverse' && kind === 'refund') {
    return lockup(
      open.swap.chainCurrency,
      open.swap.transactionId,
      open.swap.transactionVout,
      open.swap.onchainAmount,
      open.swap.redeemScript,
      open.swap.preimageHash,
    );
  }
  if (open.kind === 'submarine' && kind === 'claim') {
    return lockup(
      open.swap.chainCurrency,
      open.swap.lockupTransactionId,
      open.swap.lockupTransactionVout,
      open.swap.onchainAmount ?? open.swap.expectedAmount,
      open.swap.redeemScript,
      open.swap.preimageHash,
    );
  }
  return undefined;
};

export type RescueAdopter = {
  adoptRescueRefund: (
    swap: ChainSwapInfo | Extract<OpenSwap, { kind: 'reverse' }>['swap'],
    symbol: string,
    lockupTransactionId: string,
    refundTransactionId: string,
    vin: number,
    minerFee: number,
  ) => Promise<void>;
  adoptRescueClaim: (
    swap: ChainSwapInfo | Extract<OpenSwap, { kind: 'submarine' }>['swap'],
    preimage: Buffer,
    minerFee: number,
  ) => Promise<void>;
};

const confirmations = async (currency: Currency, txid: string) => {
  const client = currency.chainClient;
  if (client === undefined) return 0;
  try {
    return (await client.getRawTransactionVerbose(txid)).confirmations ?? 0;
  } catch {
    // Pruned node without txindex: SwapSha's own wallet knows it when the
    // rescue paid one of its addresses
    try {
      // gettransaction answers with the confirmations too, beyond the
      // fields WalletTransaction lists
      const tx = (await client.getWalletTransaction(txid)) as {
        confirmations?: number;
      };
      return tx.confirmations ?? 0;
    } catch {
      return 0;
    }
  }
};

/**
 * Checks every record against its swap and adopts the confirmed ones.
 * Returns how many records still wait (unconfirmed, or their swap not yet
 * at the stage they need).
 */
export const adoptRescues = async (
  logger: Logger,
  dataDir: string,
  currencies: Map<string, Currency>,
  adopter: RescueAdopter,
  reported: Set<string>,
): Promise<number> => {
  let records: RescueRecord[];
  try {
    records = readRescueRecords(dataDir);
  } catch (error) {
    logger.warn(`Could not read ${rescuedFileName}: ${formatError(error)}`);
    return 0;
  }

  let waiting = 0;
  for (const record of records) {
    const label = `rescue ${record.kind} ${record.txid} of swap ${record.id}`;
    try {
      const open = await findOpenSwap(record.id);
      if (open === undefined) continue;

      const lockup = lockupOf(open, record.kind);
      if (lockup === undefined) {
        if (!reported.has(label)) {
          logger.warn(
            `Not adopting ${label}: the swap has no lockup of that kind`,
          );
          reported.add(label);
        }
        continue;
      }

      const check = checkRescueSpend(record, lockup);
      if (!check.ok) {
        if (!reported.has(label)) {
          logger.warn(`Not adopting ${label}: ${check.reason}`);
          reported.add(label);
        }
        continue;
      }

      const currency = currencies.get(lockup.symbol);
      if (
        currency === undefined ||
        (await confirmations(currency, record.txid)) < 1
      ) {
        waiting++;
        continue;
      }

      if (record.kind === 'refund') {
        await adopter.adoptRescueRefund(
          open.swap as Parameters<RescueAdopter['adoptRescueRefund']>[0],
          lockup.symbol,
          lockup.transactionId,
          record.txid,
          check.vin,
          check.minerFee,
        );
      } else {
        await adopter.adoptRescueClaim(
          open.swap as Parameters<RescueAdopter['adoptRescueClaim']>[0],
          check.preimage!,
          check.minerFee,
        );
      }
      logger.info(
        `Adopted the operator's ${label}: swap marked ${
          record.kind === 'refund'
            ? SwapUpdateEvent.TransactionRefunded
            : SwapUpdateEvent.TransactionClaimed
        }`,
      );
    } catch (error) {
      logger.warn(`Could not check ${label}: ${formatError(error)}`);
      waiting++;
    }
  }
  return waiting;
};
