/** Shared helpers for the SwapSha end-to-end tests (swapsha-regtest/e2e). */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { Address, OutScript, Script, Transaction } from '@scure/btc-signer';
import {
  type ClaimDetails,
  Musig,
  Networks,
  OutputType,
  type RefundDetails,
  type SighashMode,
  SwapTreeSerializer,
  TaprootUtils,
  constructClaimTransaction,
  constructRefundTransaction,
  detectSwap,
} from 'boltz-core';
import { randomBytes } from 'node:crypto';

export const API = 'http://127.0.0.1:9001/v2';
export const SHA = 18443;
export const BLAKE = 18543;
export const port = (symbol: 'BTC' | 'XBT') => (symbol === 'BTC' ? SHA : BLAKE);
export const modeOf = (symbol: 'BTC' | 'XBT'): SighashMode =>
  symbol === 'XBT' ? 'unified' : 'legacy';

export const rpc = async <T>(
  nodePort: number,
  method: string,
  params: unknown[] = [],
  wallet = 'user',
): Promise<T> => {
  const path = wallet === '' ? '/' : `/wallet/${wallet}`;
  const res = await fetch(`http://127.0.0.1:${nodePort}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from('swapsha:swapsha').toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result: T; error: unknown };
  if (body.error) {
    throw new Error(`${method} on ${nodePort}: ${JSON.stringify(body.error)}`);
  }
  return body.result;
};

export const api = async <T>(path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T;
  if (!res.ok)
    throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const height = (nodePort: number) =>
  rpc<number>(nodePort, 'getblockcount');

export const mine = async (nodePort: number, blocks = 1) =>
  rpc(nodePort, 'generatetoaddress', [
    blocks,
    await rpc<string>(nodePort, 'getnewaddress'),
  ]);

export const mineTo = async (nodePort: number, target: number) => {
  const have = await height(nodePort);
  if (have < target) await mine(nodePort, target - have);
};

export const status = async (id: string) =>
  (await api<{ status: string; failureReason?: string }>(`/swap/${id}`)).status;

const FAILED = [
  'transaction.failed',
  'transaction.lockupFailed',
  'swap.expired',
];

/**
 * Poll until the swap reaches `want`, mining a block on `minePort` every few
 * polls. Statuses in `FAILED` abort unless they are what we want or listed in
 * `allow`.
 */
export const waitFor = async (
  id: string,
  want: string,
  minePort?: number,
  allow: string[] = [],
) => {
  for (let i = 0; i < 90; i++) {
    const s = await status(id);
    if (s === want) return;
    if (FAILED.includes(s) && !allow.includes(s)) {
      const info = await api<Record<string, unknown>>(`/swap/${id}`);
      throw new Error(`swap ${id} reached ${s}: ${JSON.stringify(info)}`);
    }
    if (minePort !== undefined && i % 5 === 4) await mine(minePort);
    await sleep(1000);
  }
  throw new Error(`swap ${id} stuck at ${await status(id)}, wanted ${want}`);
};

export const ensureUserWallets = async () => {
  for (const p of [SHA, BLAKE]) {
    try {
      await rpc(p, 'loadwallet', ['user'], '');
    } catch {
      try {
        await rpc(p, 'createwallet', ['user'], '');
      } catch {
        // already loaded
      }
    }
    // Coinbases mined now are post-fork, so they exist on this chain only.
    if ((await rpc<number>(p, 'getbalance')) < 1) await mine(p, 101);
  }
};

export type SwapData = {
  swapTree: Parameters<typeof SwapTreeSerializer.deserializeSwapTree>[0];
  serverPublicKey: string;
  amount: number;
  lockupAddress: string;
  timeoutBlockHeight: number;
};

export type CreatedSwap = {
  id: string;
  from: 'BTC' | 'XBT';
  to: 'BTC' | 'XBT';
  claimDetails: SwapData;
  lockupDetails: SwapData;
  claimKey: Uint8Array;
  refundKey: Uint8Array;
  preimage: Uint8Array;
};

export const createSwap = async (
  from: 'BTC' | 'XBT',
  to: 'BTC' | 'XBT',
  userLockAmount = 100_000,
): Promise<CreatedSwap> => {
  const pairs =
    await api<Record<string, Record<string, { hash: string }>>>('/swap/chain');
  const claimKey = secp256k1.utils.randomSecretKey();
  const refundKey = secp256k1.utils.randomSecretKey();
  const preimage = randomBytes(32);
  const swap = await api<
    Omit<CreatedSwap, 'from' | 'to' | 'claimKey' | 'refundKey' | 'preimage'>
  >('/swap/chain', {
    from,
    to,
    preimageHash: hex.encode(sha256(preimage)),
    claimPublicKey: hex.encode(secp256k1.getPublicKey(claimKey)),
    refundPublicKey: hex.encode(secp256k1.getPublicKey(refundKey)),
    userLockAmount,
    pairHash: pairs[from][to].hash,
  });
  console.log(
    `swap ${swap.id} ${from} -> ${to}: lock ${swap.lockupDetails.amount}, receive ${swap.claimDetails.amount}`,
  );
  return { ...swap, from, to, claimKey, refundKey, preimage };
};

export const lockUser = async (swap: CreatedSwap, amount?: number) => {
  const txid = await rpc<string>(port(swap.from), 'sendtoaddress', [
    swap.lockupDetails.lockupAddress,
    (amount ?? swap.lockupDetails.amount) / 1e8,
  ]);
  console.log(`user ${swap.from} lockup: ${txid}`);
  await mine(port(swap.from));
  return txid;
};

export const parseTx = (rawHex: string) =>
  Transaction.fromRaw(hex.decode(rawHex), {
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
  });

export const serverLockup = async (swap: CreatedSwap) => {
  const txs = await api<{
    serverLock: { transaction: { id: string; hex: string } };
  }>(`/swap/chain/${swap.id}/transactions`);
  return txs.serverLock.transaction;
};

/** Last byte of the first witness element of every input: the hash type. */
export const hashTypes = (tx: Transaction) =>
  Array.from({ length: tx.inputsLength }, (_, i) => {
    const sig = (tx.getInput(i).finalScriptWitness ?? [])[0];
    return sig === undefined ? undefined : sig[sig.length - 1];
  });

/** The transaction on `nodePort` that spends txid:vout, scanning recent blocks and the mempool. */
export const findSpend = async (
  nodePort: number,
  txid: string,
  lookback = 300,
): Promise<string> => {
  const spends = (tx: { vin: { txid?: string }[] }) =>
    tx.vin.some((i) => i.txid === txid);
  for (const id of await rpc<string[]>(nodePort, 'getrawmempool', [], '')) {
    const tx = await rpc<{ vin: { txid?: string }[]; hex: string }>(
      nodePort,
      'getrawtransaction',
      [id, true],
      '',
    );
    if (spends(tx)) return tx.hex;
  }
  const tip = await height(nodePort);
  for (let h = tip; h > tip - lookback && h > 0; h--) {
    const block = await rpc<{
      tx: { vin: { txid?: string }[]; hex: string }[];
    }>(
      nodePort,
      'getblock',
      [await rpc<string>(nodePort, 'getblockhash', [h], ''), 2],
      '',
    );
    const tx = block.tx.find(spends);
    if (tx !== undefined) return tx.hex;
  }
  throw new Error(`no spend of ${txid} found on ${nodePort}`);
};

const address = async (nodePort: number) =>
  OutScript.encode(
    Address(Networks.regtest).decode(
      await rpc<string>(nodePort, 'getnewaddress'),
    )!,
  );

const taprootUtxo = (
  data: SwapData,
  ourKey: Uint8Array,
  lockup: Transaction,
  lockupId: string,
) => {
  const tree = SwapTreeSerializer.deserializeSwapTree(data.swapTree);
  const musig = Musig.create(ourKey, [
    hex.decode(data.serverPublicKey),
    secp256k1.getPublicKey(ourKey),
  ]);
  const tweaked = TaprootUtils.tweakMusig(musig, tree.tree);
  const found = detectSwap(tweaked.aggPubkey, lockup);
  if (found === undefined) throw new Error('HTLC output not found');
  return {
    ...found,
    transactionId: lockupId,
    type: OutputType.Taproot,
    privateKey: ourKey,
    swapTree: tree,
    internalKey: musig.aggPubkey,
  };
};

/** User claims the server's lockup on `swap.to` via the script path. */
export const userClaim = async (
  swap: CreatedSwap,
  known?: { id: string; hex: string },
) => {
  // Pass `known` to claim without asking the backend (it may be down)
  const lock = known ?? (await serverLockup(swap));
  const claim = constructClaimTransaction(
    [
      {
        ...taprootUtxo(
          swap.claimDetails,
          swap.claimKey,
          parseTx(lock.hex),
          lock.id,
        ),
        preimage: swap.preimage,
      } as ClaimDetails,
    ],
    await address(port(swap.to)),
    1_000n,
    true,
    undefined,
    false,
    modeOf(swap.to),
  );
  return claim;
};

/** User refunds their own lockup on `swap.from` via the script path. */
export const userRefund = async (swap: CreatedSwap, lockupId: string) => {
  const raw = await rpc<string>(
    port(swap.from),
    'getrawtransaction',
    [lockupId],
    '',
  );
  const refund = constructRefundTransaction(
    [
      taprootUtxo(
        swap.lockupDetails,
        swap.refundKey,
        parseTx(raw),
        lockupId,
      ) as RefundDetails,
    ],
    await address(port(swap.from)),
    swap.lockupDetails.timeoutBlockHeight,
    1_000n,
    true,
    modeOf(swap.from),
  );
  return refund;
};

export const accept = async (nodePort: number, txHex: string) =>
  (
    await rpc<{ allowed: boolean; 'reject-reason'?: string }[]>(
      nodePort,
      'testmempoolaccept',
      [[txHex]],
      '',
    )
  )[0];

/**
 * First signature of every input, wherever it sits: the witness for segwit
 * inputs, the first scriptSig push for legacy ones (Knots 29.4.1 hands out
 * P2PKH change on XBT, and those inputs carry no witness at all).
 */
const firstSig = (tx: Transaction, i: number) => {
  const input = tx.getInput(i);
  const w = (input.finalScriptWitness ?? [])[0];
  if (w !== undefined && w.length > 0) return { sig: w, where: 'witness' };
  if (input.finalScriptSig !== undefined && input.finalScriptSig.length > 0) {
    const push = Script.decode(input.finalScriptSig)[0];
    if (push instanceof Uint8Array) return { sig: push, where: 'scriptSig' };
  }
  return undefined;
};

/** Signature length, hash-type byte and location per input, for logging. */
export const describeSigs = (tx: Transaction) =>
  Array.from({ length: tx.inputsLength }, (_, i) => {
    const found = firstSig(tx, i);
    if (found === undefined) return 'unsigned';
    const { sig, where } = found;
    if (sig.length === 64)
      return `${where} 64B schnorr (SIGHASH_DEFAULT, no opt-in)`;
    return `${where} ${sig.length}B 0x${sig[sig.length - 1].toString(16).padStart(2, '0')}`;
  }).join(', ');

/**
 * Lock BTC for `swap` with a coin mined BEFORE the fork, signed the old way.
 * That transaction is valid on the BLAKE2b chain too: the replay D18 exists
 * to catch.
 */
export const lockUserWithPreForkCoin = async (
  swap: CreatedSwap,
  forkHeight = 200,
) => {
  const tip = await height(SHA);
  const utxos = await rpc<
    { txid: string; vout: number; amount: number; confirmations: number }[]
  >(SHA, 'listunspent', [1], 'prefork');
  // The coin must still be unspent on BLAKE2b too, or the lockup cannot be
  // replayable there (other tests spend pre-fork coins on that chain)
  let coin: (typeof utxos)[number] | undefined;
  for (const u of utxos) {
    if (tip - u.confirmations + 1 >= forkHeight || u.amount <= 0.01) continue;
    if (
      (await rpc<unknown>(BLAKE, 'gettxout', [u.txid, u.vout, true], '')) !==
      null
    ) {
      coin = u;
      break;
    }
  }
  if (coin === undefined)
    throw new Error(
      'no pre-fork coin left in the prefork wallet that is unspent on both chains',
    );
  const { psbt } = await rpc<{ psbt: string }>(
    SHA,
    'walletcreatefundedpsbt',
    [
      [{ txid: coin.txid, vout: coin.vout }],
      [{ [swap.lockupDetails.lockupAddress]: swap.lockupDetails.amount / 1e8 }],
      0,
      { add_inputs: false, fee_rate: 10 },
    ],
    'prefork',
  );
  const signed = await rpc<{ psbt: string }>(
    SHA,
    'walletprocesspsbt',
    [psbt],
    'prefork',
  );
  const { hex: raw } = await rpc<{ hex: string }>(
    SHA,
    'finalizepsbt',
    [signed.psbt],
    'prefork',
  );
  const txid = await rpc<string>(SHA, 'sendrawtransaction', [raw], '');
  console.log(
    `user BTC lockup from pre-fork coin ${coin.txid}:${coin.vout}: ${txid}`,
  );
  await mine(SHA);
  return { txid, raw };
};

/**
 * testmempoolaccept on `nodePort`, after mining that chain past the
 * transaction's nLockTime. The Knots wallet sets nLockTime to its own tip
 * (anti fee sniping), and the two chains run at different heights, so
 * without this the other chain can answer non-final before it looks at the
 * inputs or the signature.
 */
export const acceptWhenFinal = async (nodePort: number, raw: string) => {
  const { locktime } = await rpc<{ locktime: number }>(
    nodePort,
    'decoderawtransaction',
    [raw],
    '',
  );
  if (locktime < 500_000_000) await mineTo(nodePort, locktime + 1);
  return accept(nodePort, raw);
};
