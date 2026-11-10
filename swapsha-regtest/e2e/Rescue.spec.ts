/**
 * A4b: the operator rescue (Blueprint D44) against the StartOS package in test
 * mode, on testnet4 only: SwapSha locks coins, the user never claims, the
 * operator stops SwapSha in StartOS, and after the timeout runs the Rescue
 * Swap action, which refunds SwapSha's lockup from the rescue file with the
 * key derived from seed.dat (patch 0056). Each test checks the refund it finds
 * on chain: the refund leaf of the swap's own script, signed with 0x21 on BTC
 * and plainly on SHA-256, and not valid on the other chain.
 *
 * The tests ask for two things by hand and wait for them: stopping SwapSha
 * (they poll the API until it stops answering) and running Rescue Swap (they
 * poll the node until SwapSha's lockup is spent). They print what to enter.
 *
 * Needs the Mac's testnet4 nodes opened to the server (swapsha_testnet4.sh
 * lan), the provider Lightning Fork node for the type 2 test, and SwapSha in
 * test mode with patch 0056 in its image. Run from swapsha-backend:
 *   SWAPSHA_NET=testnet4 SWAPSHA_API=https://192.168.4.21:54625/v2 \
 *   NODE_OPTIONS=--use-system-ca npx jest --rootDir . \
 *   swapsha-regtest/e2e/Rescue.spec.ts --runInBand -t "type 2"
 * (or -t "chain swap"). Both can run at once in two windows: one stop of
 * SwapSha serves both.
 *
 * The chain swap test saves the user's refund key before it locks anything
 * (saveUserRefund), so the user's own lockup can still be refunded if the test
 * is stopped: SWAPSHA_REFUND_FILE=<that file> with -t "saved".
 */
import { hex } from '@scure/base';
import {
  API,
  BLAKE,
  LIVE,
  SHA,
  TEST_TIMEOUT,
  createSwap,
  describeSigs,
  ensureUserWallets,
  expectInvalidOn,
  findSpend,
  height,
  lockUser,
  mine,
  mineTo,
  parseTx,
  port,
  rpc,
  serverLockup,
  sleep,
  userRefund,
  waitFor,
} from './helpers';
import { createReverse, payAsync, reverseLockup, stopPayments } from './ln';
import { loadUserRefund, saveUserRefund } from './refundKeys';

const UNIFIED = 0x21;
// SwapSha's node wallets in test mode (startos/utils.ts testWalletName)
const SWAPSHA_WALLET = 'swapsha-start9';

type Tree = { refundLeaf: { output: string } };

const chainName = (nodePort: number) => (nodePort === SHA ? 'SHA-256' : 'BTC');

/** Poll the API until it stops answering twice in a row. */
const waitUntilStopped = async () => {
  let misses = 0;
  while (misses < 2) {
    try {
      await fetch(`${API}/swap/chain`, { signal: AbortSignal.timeout(5_000) });
      misses = 0;
    } catch {
      misses++;
    }
    await sleep(10_000);
  }
  console.log('SwapSha is stopped (its API no longer answers)');
};

/** The output of `raw` that pays `address`. */
const voutTo = async (nodePort: number, raw: string, address: string) => {
  const tx = await rpc<{
    vout: { n: number; scriptPubKey: { address?: string } }[];
  }>(nodePort, 'decoderawtransaction', [raw], '');
  const out = tx.vout.find((o) => o.scriptPubKey.address === address);
  if (out === undefined) throw new Error(`no output to ${address}`);
  return out.n;
};

/** Poll until txid:vout is spent, in the mempool or a block. */
const waitUntilSpent = async (nodePort: number, txid: string, vout: number) => {
  let last = -1;
  for (;;) {
    const coin = await rpc<unknown>(
      nodePort,
      'gettxout',
      [txid, vout, true],
      '',
    );
    if (coin === null) return;
    const now = await height(nodePort);
    if (now !== last) {
      console.log(
        `${chainName(nodePort)} block ${now}: SwapSha's lockup still unspent`,
      );
      last = now;
    }
    await sleep(15_000);
  }
};

const rescue = async ({
  id,
  nodePort,
  lockId,
  lockHex,
  lockupAddress,
  timeout,
  tree,
}: {
  id: string;
  nodePort: number;
  lockId: string;
  lockHex: string;
  lockupAddress: string;
  timeout: number;
  tree: Tree;
}) => {
  const vout = await voutTo(nodePort, lockHex, lockupAddress);
  console.log(
    [
      `SwapSha's ${chainName(nodePort)} lockup ${lockId}:${vout} is confirmed.`,
      `1. In StartOS, run Export Rescue Data: swap ${id} should say "Refund its own lockup ... from block ${timeout}".`,
      '2. Stop SwapSha; with another rescue test running, first wait until it says this too. Keep SwapSha stopped until this test says its refund is confirmed.',
    ].join('\n'),
  );
  await waitUntilStopped();

  await mineTo(nodePort, timeout);
  const address = await rpc<string>(
    nodePort,
    'getnewaddress',
    [],
    SWAPSHA_WALLET,
  );
  console.log(
    [
      `${chainName(nodePort)} reached block ${timeout}. Run Rescue Swap now:`,
      `  Swap: ${id}`,
      `  Address: ${address}   (SwapSha's own ${SWAPSHA_WALLET} wallet)`,
      '  Fee rate: 2',
      '  Broadcast: on',
    ].join('\n'),
  );
  await waitUntilSpent(nodePort, lockId, vout);

  const refund = parseTx(await findSpend(nodePort, lockId));
  console.log(`rescue refund ${refund.id}: ${describeSigs(refund)}`);
  const witness = refund.getInput(0).finalScriptWitness!;
  // Script path: signature, the swap's refund leaf, control block
  expect(witness).toHaveLength(3);
  expect(hex.encode(witness[1])).toBe(tree.refundLeaf.output);
  if (nodePort === BLAKE) {
    expect(witness[0]).toHaveLength(65);
    expect(witness[0][64]).toBe(UNIFIED);
  } else {
    expect(witness[0]).toHaveLength(64);
  }
  // Paid to the address given in Rescue Swap
  const decoded = await rpc<{ vout: { scriptPubKey: { address?: string } }[] }>(
    nodePort,
    'decoderawtransaction',
    [refund.hex],
    '',
  );
  expect(decoded.vout.map((o) => o.scriptPubKey.address)).toContain(address);
  await expectInvalidOn(nodePort === SHA ? BLAKE : SHA, refund.hex);

  await mine(nodePort);
  console.log(
    `rescue refund confirmed in ${chainName(nodePort)} block ${await height(nodePort)}. SwapSha can be started again once no other rescue test is waiting.`,
  );
};

(LIVE ? describe : describe.skip)(
  'A4b: Rescue Swap with SwapSha stopped (testnet4)',
  () => {
    jest.setTimeout(TEST_TIMEOUT);

    afterAll(stopPayments);

    test('type 2: SwapSha refunds its SHA256 lockup through Rescue Swap', async () => {
      await ensureUserWallets([SHA]);
      const swap = await createReverse();
      // Paid and never claimed: the hold invoice stays accepted while SwapSha
      // is stopped, until it is cancelled
      payAsync(swap.invoice);
      await waitFor(swap.id, 'transaction.mempool');
      const lock = await reverseLockup(swap.id);
      await mine(SHA);
      await waitFor(swap.id, 'transaction.confirmed', SHA);

      await rescue({
        id: swap.id,
        nodePort: SHA,
        lockId: lock.id,
        lockHex: lock.hex,
        lockupAddress: swap.claimDetails.lockupAddress,
        timeout: swap.claimDetails.timeoutBlockHeight,
        tree: swap.claimDetails.swapTree as unknown as Tree,
      });
    });

    test('chain swap: SwapSha refunds its BTC lockup through Rescue Swap, signed 0x21', async () => {
      await ensureUserWallets();
      const swap = await createSwap('SHA256', 'BTC');
      const file = await saveUserRefund(swap);
      console.log(`user refund key saved to ${file}`);
      const userLock = await lockUser(swap);
      await saveUserRefund(swap, userLock);
      await waitFor(swap.id, 'transaction.server.mempool', SHA);
      const lock = await serverLockup(swap);
      await mine(BLAKE);
      await waitFor(swap.id, 'transaction.server.confirmed', BLAKE);

      await rescue({
        id: swap.id,
        nodePort: BLAKE,
        lockId: lock.id,
        lockHex: lock.hex,
        lockupAddress: swap.claimDetails.lockupAddress,
        timeout: swap.claimDetails.timeoutBlockHeight,
        tree: swap.claimDetails.swapTree as unknown as Tree,
      });

      // The user's own SHA256 lockup, after its timeout
      await mineTo(port('SHA256'), swap.lockupDetails.timeoutBlockHeight);
      const refund = await userRefund(swap, userLock);
      console.log(
        `user SHA256 refund: ${await rpc(SHA, 'sendrawtransaction', [refund.hex], '')}`,
      );
      await mine(SHA);
    });

    (process.env.SWAPSHA_REFUND_FILE ? test : test.skip)(
      'saved: user refunds a saved lockup after its timeout',
      async () => {
        const { swap, lockupId } = await loadUserRefund(
          process.env.SWAPSHA_REFUND_FILE!,
        );
        await mineTo(port(swap.from), swap.lockupDetails.timeoutBlockHeight);
        const refund = await userRefund(swap, lockupId);
        console.log(
          `user ${swap.from} refund of ${swap.id}: ${await rpc(port(swap.from), 'sendrawtransaction', [refund.hex], '')}`,
        );
        await mine(port(swap.from));
      },
    );
  },
);
