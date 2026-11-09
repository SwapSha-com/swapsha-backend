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

/**
 * SWAPSHA_NET=testnet4 runs the same suites against the public testnet4
 * nodes from swapsha_testnet4.sh and the backend from swapsha-testnet4/run.sh.
 * Nothing can be mined there, so mine() and mineTo() wait for real blocks.
 */
export const NET: 'regtest' | 'testnet4' =
  process.env.SWAPSHA_NET === 'testnet4' ? 'testnet4' : 'regtest';
export const LIVE = NET === 'testnet4';

// SWAPSHA_API points the suites at another backend, such as the StartOS
// package in test mode (Blueprint D46) through its API interface:
//   SWAPSHA_API=https://192.168.4.21:54625/v2
// (the server's LAN IP and the API interface's port, from its Interfaces
// page; StartOS can give the interface a new port when it is reinstalled)
// with NODE_OPTIONS=--use-system-ca so Node trusts the server's root CA from
// the Mac's keychain. The user's side still runs on this Mac's nodes.
export const API =
  process.env.SWAPSHA_API ??
  (LIVE ? 'http://127.0.0.1:9101/v2' : 'http://127.0.0.1:9001/v2');
export const SHA = LIVE ? 48332 : 18443;
export const BLAKE = LIVE ? 48432 : 18543;

/**
 * Jest timeout per test: refunds on testnet4 wait for real timeouts. The
 * user's SHA-256 lockup in a SHA256 -> BTC swap times out about 175 blocks
 * after it is made, stretched for the worst pace pairing (D30): 18 to 55
 * hours at the measured testnet4 pace, so 12 hours cut the backend refund
 * test off before its cleanup (Nov 9).
 */
export const TEST_TIMEOUT = LIVE ? 72 * 60 * 60 * 1000 : 600_000;
export const port = (symbol: 'SHA256' | 'BTC') =>
  symbol === 'SHA256' ? SHA : BLAKE;
export const modeOf = (symbol: 'SHA256' | 'BTC'): SighashMode =>
  symbol === 'BTC' ? 'unified' : 'legacy';

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

const chainName = (nodePort: number) => (nodePort === SHA ? 'SHA256' : 'BTC');

/** testnet4: wait until `nodePort` reaches `target`, logging every new block. */
const waitForHeight = async (nodePort: number, target: number) => {
  let last = await height(nodePort);
  if (last >= target) return;
  console.log(
    `waiting for ${chainName(nodePort)} block ${target} (now ${last}, ~${(target - last) * 10} min)`,
  );
  while (last < target) {
    await sleep(15_000);
    const now = await height(nodePort);
    if (now !== last) {
      console.log(`${chainName(nodePort)} block ${now} of ${target}`);
      last = now;
    }
  }
};

export const mine = async (nodePort: number, blocks = 1) => {
  if (LIVE) {
    await waitForHeight(nodePort, (await height(nodePort)) + blocks);
    return;
  }
  await rpc(nodePort, 'generatetoaddress', [
    blocks,
    await rpc<string>(nodePort, 'getnewaddress'),
  ]);
};

export const mineTo = async (nodePort: number, target: number) => {
  if (LIVE) return waitForHeight(nodePort, target);
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
  // testnet4: no mining, poll for up to 3 hours (a few slow blocks)
  const polls = LIVE ? 3 * 60 * 6 : 90;
  const every = LIVE ? 10_000 : 1000;
  let seen = '';
  for (let i = 0; i < polls; i++) {
    const s = await status(id);
    if (s === want) return;
    if (LIVE && s !== seen) {
      console.log(`swap ${id}: ${s} (waiting for ${want})`);
      seen = s;
    }
    if (FAILED.includes(s) && !allow.includes(s)) {
      const info = await api<Record<string, unknown>>(`/swap/${id}`);
      throw new Error(`swap ${id} reached ${s}: ${JSON.stringify(info)}`);
    }
    if (!LIVE && minePort !== undefined && i % 5 === 4) await mine(minePort);
    await sleep(every);
  }
  throw new Error(`swap ${id} stuck at ${await status(id)}, wanted ${want}`);
};

/**
 * Load the user wallets on `chains` and make sure they can fund the tests.
 * The Lightning suites pass [SHA] only: their BTC side is the user's
 * Lightning Fork node, not an on-chain wallet.
 */
export const ensureUserWallets = async (chains: number[] = [SHA, BLAKE]) => {
  if (LIVE) {
    // testnet4: coins come from faucets and the community, not from mining
    const missing: string[] = [];
    for (const p of chains) {
      try {
        await rpc(p, 'loadwallet', ['user'], '');
      } catch {
        // already loaded, or created by swapsha_testnet4.sh wallets
      }
      // Confirmed and not locked (listunspent leaves locked coins out):
      // what the swaps can actually spend
      const balance = (
        await rpc<{ amount: number }[]>(p, 'listunspent', [1])
      ).reduce((sum, u) => sum + u.amount, 0);
      if (balance < 0.005) {
        missing.push(
          `${chainName(p)} user wallet has ${balance.toFixed(8)} spendable, needs 0.005: send testnet4 coins to ${await rpc<string>(p, 'getnewaddress', ['', 'bech32'])}`,
        );
      }
    }
    if (missing.length > 0) throw new Error(missing.join('\n'));
    return;
  }
  for (const p of chains) {
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
  from: 'SHA256' | 'BTC';
  to: 'SHA256' | 'BTC';
  claimDetails: SwapData;
  lockupDetails: SwapData;
  claimKey: Uint8Array;
  refundKey: Uint8Array;
  preimage: Uint8Array;
};

export const createSwap = async (
  from: 'SHA256' | 'BTC',
  to: 'SHA256' | 'BTC',
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
    Address(LIVE ? Networks.testnet : Networks.regtest).decode(
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

/**
 * A transaction's hex. D38 V2 runs the SHA256 regtest node pruned with no
 * txindex, where getrawtransaction only answers for the mempool; the test
 * wallets still have every transaction they sent or received.
 */
export const rawTransaction = async (
  nodePort: number,
  txid: string,
): Promise<string> => {
  try {
    return await rpc<string>(nodePort, 'getrawtransaction', [txid], '');
  } catch (error) {
    if (!/-txindex/.test((error as Error).message)) throw error;
  }
  for (const wallet of ['user', 'swapsha', 'prefork', 'guard-user']) {
    try {
      return (
        await rpc<{ hex: string }>(nodePort, 'gettransaction', [txid], wallet)
      ).hex;
    } catch {
      // Not this wallet's, or not loaded
    }
  }
  throw new Error(
    `${chainName(nodePort)}: ${txid} is not in the mempool or any test wallet (pruned node, no txindex)`,
  );
};

/** User refunds their own lockup on `swap.from` via the script path. */
export const userRefund = async (swap: CreatedSwap, lockupId: string) => {
  const raw = await rawTransaction(port(swap.from), lockupId);
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
 * P2PKH change on BTC, and those inputs carry no witness at all).
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
 * Lock SHA256 for `swap` with a coin mined BEFORE the fork, signed the old way.
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
      // nLockTime 1: final on both chains. 0 lets the wallet use its tip.
      1,
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
    `user SHA256 lockup from pre-fork coin ${coin.txid}:${coin.vout}: ${txid}`,
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

/**
 * Assert a transaction from the other chain is not valid on `nodePort`.
 * The node can answer non-final before it looks at the inputs: the Knots
 * wallet sets nLockTime to its own chain's tip, and the two chains run at
 * different heights (on testnet4 BLAKE2b is thousands of blocks behind; on
 * regtest the Lightning suites mine only SHA256, and mining BLAKE2b to catch
 * up would move the Lightning HTLCs too). Then every input must be absent
 * from that chain's UTXO set and mempool, which is what missing-inputs would
 * have said. That the coins exist on one chain only is what the D26 startup
 * guard proved.
 */
export const expectInvalidOn = async (nodePort: number, raw: string) => {
  const result = await accept(nodePort, raw);
  console.log(
    `on ${chainName(nodePort)}: allowed=${result.allowed} ${result['reject-reason'] ?? ''}`,
  );
  expect(result.allowed).toBe(false);
  expect(result['reject-reason']).toMatch(
    LIVE
      ? /missing-inputs|non-final|script-verify/
      : /missing-inputs|non-final/,
  );
  if (result['reject-reason'] === 'non-final') {
    const tx = parseTx(raw);
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      const coin = await rpc<unknown>(
        nodePort,
        'gettxout',
        [hex.encode(input.txid!), input.index!, true],
        '',
      );
      expect(coin).toBeNull();
    }
    console.log(
      `on ${chainName(nodePort)}: none of the ${tx.inputsLength} input(s) exist there`,
    );
  }
  return result;
};
