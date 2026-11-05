/**
 * Lightning helpers for the SwapSha end-to-end tests (Phase 2, L4).
 *
 * The `user` and `prov` nodes are the two Lightning Fork nodes from
 * ~/Claude/swapsha/lightning/swapsha_ln_regtest.sh, with a channel
 * prov -> user. `prov` is SwapSha's node (boltz.conf [[currencies.lnds]]);
 * `user` plays the swap user. Set SWAPSHA_LN to the script's path if it is
 * not at ../lightning/swapsha_ln_regtest.sh from swapsha-backend.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import bolt11 from 'bolt11';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { type CreatedSwap, type SwapData, api, height, rpc } from './helpers';

const SCRIPT = process.env.SWAPSHA_LN ?? '../lightning/swapsha_ln_regtest.sh';

export type Node = 'prov' | 'user';

/** lncli on one of the two nodes, parsed as JSON. */
export const lncli = <T>(node: Node, ...args: string[]): Promise<T> =>
  new Promise((resolve, reject) => {
    execFile(
      SCRIPT,
      ['cli', node, ...args],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`lncli ${node} ${args[0]}: ${stderr || stdout || error.message}`));
          return;
        }
        resolve(JSON.parse(stdout) as T);
      },
    );
  });

/** A Lightning Fork invoice from the user's node. */
export const userInvoice = async (sats: number) => {
  const res = await lncli<{ r_hash: string; payment_request: string }>(
    'user',
    'addinvoice',
    '--amt',
    String(sats),
    '--memo',
    'swapsha e2e',
  );
  return { invoice: res.payment_request, paymentHash: res.r_hash };
};

export type InvoiceState = 'OPEN' | 'SETTLED' | 'CANCELED' | 'ACCEPTED';

export const invoiceState = async (node: Node, paymentHash: string) =>
  (await lncli<{ state: InvoiceState }>(node, 'lookupinvoice', paymentHash)).state;

/** Feature bit numbers an invoice sets, as the user's Lightning Fork node reads them. */
export const invoiceFeatures = async (invoice: string) =>
  Object.keys(
    (await lncli<{ features: Record<string, unknown> }>('user', 'decodepayreq', invoice))
      .features,
  ).map(Number);

export type Payment = { process: ChildProcess; result: Promise<string> };

/**
 * The user pays `invoice` without waiting: a hold invoice keeps lncli
 * running until SwapSha settles or cancels it. `result` resolves to the
 * payment's final status (SUCCEEDED or FAILED) with lncli's output.
 */
export const payAsync = (invoice: string): Payment => {
  const child = spawn(SCRIPT, [
    'cli',
    'user',
    'payinvoice',
    '--force',
    '--json',
    '--timeout',
    '1200s',
    invoice,
  ]);
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const result = new Promise<string>((resolve) => {
    child.on('close', () => {
      const statuses = [...out.matchAll(/"status":\s*"([A-Z_]+)"/g)].map((m) => m[1]);
      const final = statuses[statuses.length - 1] ?? 'FAILED';
      console.log(`user payment finished: ${final}`);
      resolve(`${final}\n${out}`);
    });
  });
  return { process: child, result };
};

/** Seconds since the tip block of `nodePort` was made. */
export const tipAge = async (nodePort: number) => {
  const hash = await rpc<string>(nodePort, 'getblockhash', [await height(nodePort)], '');
  const { time } = await rpc<{ time: number }>(nodePort, 'getblockheader', [hash], '');
  return Math.floor(Date.now() / 1000) - time;
};

const REGTEST = {
  bech32: 'bcrt',
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  validWitnessVersions: [0, 1],
};

/**
 * A validly signed regtest invoice from a random node that looks like a
 * stock lnd one: features 8, 14 and 17, and no option_blake2b. That is what
 * an invoice from the SHA-256 (Spamcoin) Lightning network looks like, since
 * both networks use the same prefix and chain hash. With `withBlake2b` it
 * also sets bit 512, as a control.
 */
export const craftedInvoice = (sats: number, withBlake2b = false) => {
  const key = randomBytes(32);
  const featureBits: Record<string, unknown> = {
    var_onion_optin: { required: true, supported: false },
    payment_secret: { required: true, supported: false },
    basic_mpp: { required: false, supported: true },
  };
  if (withBlake2b) {
    // bolt11 encodes its named features as bits 0 to 19; extra bits start at 20
    const bits = new Array(512 - 20 + 2).fill(false);
    bits[512 - 20] = true;
    featureBits.extra_bits = { start_bit: 20, bits, has_required: true };
  }
  const encoded = bolt11.encode({
    network: REGTEST,
    satoshis: sats,
    timestamp: Math.floor(Date.now() / 1000),
    payeeNodeKey: hex.encode(secp256k1.getPublicKey(key, true)),
    tags: [
      { tagName: 'payment_hash', data: hex.encode(sha256(randomBytes(32))) },
      { tagName: 'payment_secret', data: hex.encode(randomBytes(32)) },
      { tagName: 'description', data: 'Spamcoin Lightning invoice' },
      { tagName: 'expire_time', data: 3600 },
      { tagName: 'feature_bits', data: featureBits },
    ],
  } as never);
  return bolt11.sign(encoded, Buffer.from(key)).paymentRequest!;
};

/* ---------- swaps ---------- */

type SubmarineResponse = {
  id: string;
  address: string;
  expectedAmount: number;
  claimPublicKey: string;
  timeoutBlockHeight: number;
  swapTree: SwapData['swapTree'];
};

/**
 * Type 1: Spamcoin on chain to a BTC Lightning invoice. Returned in the
 * CreatedSwap shape so lockUser and userRefund from helpers.ts work on it.
 */
export const createSubmarine = async (invoice: string): Promise<CreatedSwap> => {
  const refundKey = secp256k1.utils.randomSecretKey();
  const pairs = await api<Record<string, Record<string, { hash: string }>>>('/swap/submarine');
  const res = await api<SubmarineResponse>('/swap/submarine', {
    from: 'SHA256',
    to: 'BTC',
    invoice,
    refundPublicKey: hex.encode(secp256k1.getPublicKey(refundKey)),
    pairHash: pairs.SHA256.BTC.hash,
  });
  console.log(
    `submarine ${res.id} SHA256 -> BTC Lightning: lock ${res.expectedAmount} by SHA256 block ${res.timeoutBlockHeight}`,
  );
  const lockupDetails: SwapData = {
    swapTree: res.swapTree,
    serverPublicKey: res.claimPublicKey,
    amount: res.expectedAmount,
    lockupAddress: res.address,
    timeoutBlockHeight: res.timeoutBlockHeight,
  };
  return {
    id: res.id,
    from: 'SHA256',
    to: 'BTC',
    lockupDetails,
    claimDetails: lockupDetails,
    refundKey,
    claimKey: refundKey,
    preimage: new Uint8Array(32),
  };
};

type ReverseResponse = {
  id: string;
  invoice: string;
  lockupAddress: string;
  refundPublicKey: string;
  timeoutBlockHeight: number;
  onchainAmount: number;
  swapTree: SwapData['swapTree'];
};

export type ReverseSwap = CreatedSwap & { invoice: string; paymentHash: string };

/**
 * Type 2: the user pays a BTC Lightning hold invoice and claims Spamcoin on
 * chain. Returned in the CreatedSwap shape so userClaim works on it.
 */
export const createReverse = async (
  invoiceAmount = 100_000,
  invoiceExpiry?: number,
): Promise<ReverseSwap> => {
  const claimKey = secp256k1.utils.randomSecretKey();
  const preimage = randomBytes(32);
  const paymentHash = hex.encode(sha256(preimage));
  const pairs = await api<Record<string, Record<string, { hash: string }>>>('/swap/reverse');
  const res = await api<ReverseResponse>('/swap/reverse', {
    from: 'BTC',
    to: 'SHA256',
    invoiceAmount,
    preimageHash: paymentHash,
    claimPublicKey: hex.encode(secp256k1.getPublicKey(claimKey)),
    pairHash: pairs.BTC.SHA256.hash,
    ...(invoiceExpiry === undefined ? {} : { invoiceExpiry }),
  });
  console.log(
    `reverse ${res.id} BTC Lightning -> SHA256: pay ${invoiceAmount}, receive ${res.onchainAmount} on SHA256, timeout block ${res.timeoutBlockHeight}`,
  );
  const claimDetails: SwapData = {
    swapTree: res.swapTree,
    serverPublicKey: res.refundPublicKey,
    amount: res.onchainAmount,
    lockupAddress: res.lockupAddress,
    timeoutBlockHeight: res.timeoutBlockHeight,
  };
  return {
    id: res.id,
    from: 'BTC',
    to: 'SHA256',
    claimDetails,
    lockupDetails: claimDetails,
    claimKey,
    refundKey: claimKey,
    preimage,
    invoice: res.invoice,
    paymentHash,
  };
};

/** SwapSha's Spamcoin lockup for a reverse swap. */
export const reverseLockup = (id: string) =>
  api<{ id: string; hex: string }>(`/swap/reverse/${id}/transaction`);
