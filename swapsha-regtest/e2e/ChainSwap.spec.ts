/**
 * B5: end-to-end BTC -> XBT chain swap against the running SwapSha backend.
 *
 * Needs, all running:
 *   ~/Claude/swapsha/regtest/swapsha_regtest.sh start   (+ `provider` done once)
 *   ./swapsha-regtest/run.sh                              (backend + sidecar)
 *
 * Run from swapsha-backend:
 *   npx jest --rootDir . swapsha-regtest/e2e --runInBand
 *
 * Flow (the user side is played by this test):
 *   1. Create a BTC -> XBT chain swap over the public API
 *   2. Lock BTC on the SHA-256 chain from the "user" wallet (post-fork coins)
 *   3. Backend locks XBT on the BLAKE2b chain; check its wallet signed with
 *      SIGHASH_UNIFIED (D23 relies on this)
 *   4. Claim the XBT via the script path with sighashMode 'unified'
 *   5. Backend sees the preimage and claims the BTC: swap ends transaction.claimed
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { Address, OutScript, Transaction } from '@scure/btc-signer';
import {
  Musig,
  Networks,
  OutputType,
  SwapTreeSerializer,
  TaprootUtils,
  constructClaimTransaction,
  detectSwap,
} from 'boltz-core';
import type { ClaimDetails } from 'boltz-core';
import { randomBytes } from 'node:crypto';

const API = 'http://127.0.0.1:9001/v2';
const SHA = 18443;
const BLAKE = 18543;
const AMOUNT = 100_000;

const rpc = async <T>(
  port: number,
  method: string,
  params: unknown[] = [],
  wallet = 'user',
): Promise<T> => {
  const path = wallet === '' ? '/' : `/wallet/${wallet}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from('swapsha:swapsha').toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result: T; error: unknown };
  if (body.error) {
    throw new Error(`${method} on ${port}: ${JSON.stringify(body.error)}`);
  }
  return body.result;
};

const api = async <T>(path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok)
    throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};

const mine = async (port: number, blocks = 1) =>
  rpc(port, 'generatetoaddress', [
    blocks,
    await rpc<string>(port, 'getnewaddress'),
  ]);

const status = async (id: string) =>
  (await api<{ status: string }>(`/swap/${id}`)).status;

/** Poll until the swap reaches `want`, mining a block on `minePort` between polls. */
const waitFor = async (id: string, want: string, minePort?: number) => {
  for (let i = 0; i < 60; i++) {
    const s = await status(id);
    if (s === want) return;
    if (
      [
        'transaction.failed',
        'transaction.lockupFailed',
        'swap.expired',
      ].includes(s)
    ) {
      throw new Error(`swap ${id} failed with ${s}`);
    }
    if (minePort !== undefined && i % 5 === 4) await mine(minePort);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`swap ${id} stuck at ${await status(id)}, wanted ${want}`);
};

const ensureUserWallet = async (port: number) => {
  try {
    await rpc(port, 'loadwallet', ['user'], '');
  } catch {
    try {
      await rpc(port, 'createwallet', ['user'], '');
    } catch {
      // already loaded
    }
  }
};

describe('B5: BTC -> XBT chain swap', () => {
  jest.setTimeout(300_000);

  beforeAll(async () => {
    await ensureUserWallet(SHA);
    await ensureUserWallet(BLAKE);
    // The user's BTC comes from coinbases mined after the fork, so it exists
    // on the SHA-256 chain only. 101 blocks makes the first one spendable.
    if ((await rpc<number>(SHA, 'getbalance')) < 1) await mine(SHA, 101);
  });

  test('completes with a replay-protected XBT claim', async () => {
    const pairs =
      await api<Record<string, Record<string, { hash: string }>>>(
        '/swap/chain',
      );
    const pairHash = pairs.BTC.XBT.hash;

    const claimKey = secp256k1.utils.randomSecretKey();
    const refundKey = secp256k1.utils.randomSecretKey();
    const preimage = randomBytes(32);

    // 1. Create
    const swap = await api<{
      id: string;
      claimDetails: {
        swapTree: Parameters<typeof SwapTreeSerializer.deserializeSwapTree>[0];
        serverPublicKey: string;
        amount: number;
        lockupAddress: string;
        timeoutBlockHeight: number;
      };
      lockupDetails: { lockupAddress: string; amount: number; bip21?: string };
    }>('/swap/chain', {
      from: 'BTC',
      to: 'XBT',
      preimageHash: hex.encode(sha256(preimage)),
      claimPublicKey: hex.encode(secp256k1.getPublicKey(claimKey)),
      refundPublicKey: hex.encode(secp256k1.getPublicKey(refundKey)),
      userLockAmount: AMOUNT,
      pairHash,
    });
    console.log(
      `swap ${swap.id}: lock ${swap.lockupDetails.amount} sat BTC, receive ${swap.claimDetails.amount} sat XBT`,
    );
    expect(swap.claimDetails.lockupAddress.startsWith('bcrt1p')).toBe(true);

    // 2. User locks BTC on the SHA-256 chain
    const userLockTx = await rpc<string>(SHA, 'sendtoaddress', [
      swap.lockupDetails.lockupAddress,
      swap.lockupDetails.amount / 1e8,
    ]);
    console.log(`user BTC lockup: ${userLockTx}`);
    await mine(SHA);

    // 3. Backend locks XBT on the BLAKE2b chain
    await waitFor(swap.id, 'transaction.server.mempool', SHA);
    const txs = await api<{
      serverLock: { transaction: { id: string; hex: string } };
    }>(`/swap/chain/${swap.id}/transactions`);
    const serverLock = Transaction.fromRaw(
      hex.decode(txs.serverLock.transaction.hex),
      {
        allowUnknownOutputs: true,
      },
    );
    console.log(`server XBT lockup: ${txs.serverLock.transaction.id}`);

    // The Knots wallet must have opted in on every input it signed.
    for (let i = 0; i < serverLock.inputsLength; i++) {
      const witness = serverLock.getInput(i).finalScriptWitness ?? [];
      expect(witness.length).toBeGreaterThan(0);
      const sig = witness[0];
      expect(sig[sig.length - 1]).toBe(0x21);
    }

    // The same lockup must not be valid on the SHA-256 chain.
    const onSha = (
      await rpc<{ allowed: boolean }[]>(SHA, 'testmempoolaccept', [
        [txs.serverLock.transaction.hex],
      ])
    )[0];
    expect(onSha.allowed).toBe(false);

    await mine(BLAKE);
    await waitFor(swap.id, 'transaction.server.confirmed', BLAKE);

    // 4. User claims XBT via the script path, signed with SIGHASH_UNIFIED
    const tree = SwapTreeSerializer.deserializeSwapTree(
      swap.claimDetails.swapTree,
    );
    const musig = Musig.create(claimKey, [
      hex.decode(swap.claimDetails.serverPublicKey),
      secp256k1.getPublicKey(claimKey),
    ]);
    const tweaked = TaprootUtils.tweakMusig(musig, tree.tree);
    const found = detectSwap(tweaked.aggPubkey, serverLock)!;
    expect(found).toBeDefined();

    const destination = OutScript.encode(
      Address(Networks.regtest).decode(
        await rpc<string>(BLAKE, 'getnewaddress'),
      )!,
    );
    const claim = constructClaimTransaction(
      [
        {
          ...found,
          transactionId: txs.serverLock.transaction.id,
          type: OutputType.Taproot,
          preimage,
          privateKey: claimKey,
          swapTree: tree,
          internalKey: musig.aggPubkey,
        } as ClaimDetails,
      ],
      destination,
      1_000n,
      true,
      undefined,
      false,
      'unified',
    );
    expect(claim.getInput(0).finalScriptWitness![0]).toHaveLength(65);
    const claimId = await rpc<string>(BLAKE, 'sendrawtransaction', [claim.hex]);
    console.log(`user XBT claim: ${claimId}`);
    await mine(BLAKE);

    // 5. Backend claims the BTC with the revealed preimage
    await waitFor(swap.id, 'transaction.claimed', SHA);
    console.log(`swap ${swap.id}: transaction.claimed`);
  });
});
