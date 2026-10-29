/**
 * B5 crash test: SIGKILL the backend at the three points where a lost swap
 * would cost someone money, move the chains on while it is down, restart it,
 * and check the swap finishes the right way with no double lockup.
 *
 *   1. User locks while the backend is down.
 *      Expect: backend finds the lockup on restart and locks its side once.
 *   2. User claims (revealing the preimage) while the backend is down.
 *      Expect: backend finds the claim on restart and claims the user's coins.
 *   3. The XBT timeout passes while the backend is down.
 *      Expect: backend refunds its XBT lockup on restart, signed 0x21.
 *
 * This test runs the backend itself. Any backend already running (run.sh) is
 * killed at the start. Restart run.sh afterwards.
 *
 * Run from swapsha-backend, chains up:
 *   SWAPSHA_CRASH=1 npx jest --rootDir . swapsha-regtest/e2e/Crash.spec.ts --runInBand
 */
import { LOG, apiUp, crash, start, stop } from './backend';
import {
  BLAKE,
  SHA,
  accept,
  createSwap,
  describeSigs,
  ensureUserWallets,
  findSpend,
  lockUser,
  mine,
  mineTo,
  parseTx,
  rpc,
  serverLockup,
  status,
  userClaim,
  userRefund,
  waitFor,
} from './helpers';

const UNIFIED = 0x21;
const run = process.env.SWAPSHA_CRASH === '1' ? describe : describe.skip;

/** Every transaction on `nodePort` that spends any output of `txid`. */
const spendsOf = async (nodePort: number, txid: string) => {
  type Tx = { txid: string; vin: { txid?: string }[] };
  const found: string[] = [];
  const check = (tx: Tx) => {
    if (tx.vin.some((i) => i.txid === txid)) found.push(tx.txid);
  };
  for (const id of await rpc<string[]>(nodePort, 'getrawmempool', [], '')) {
    check(await rpc<Tx>(nodePort, 'getrawtransaction', [id, true], ''));
  }
  const tip = await rpc<number>(nodePort, 'getblockcount', [], '');
  for (let h = tip; h > tip - 300 && h > 0; h--) {
    const block = await rpc<{ tx: Tx[] }>(
      nodePort,
      'getblock',
      [await rpc<string>(nodePort, 'getblockhash', [h], ''), 2],
      '',
    );
    block.tx.forEach(check);
  }
  return found;
};

/** How many times the backend's XBT wallet has paid `address`. */
const serverLockupsTo = async (address: string) => {
  const sent = (
    await rpc<{ category: string; address?: string; txid: string }[]>(
      BLAKE,
      'listtransactions',
      ['*', 1000, 0, true],
      'swapsha',
    )
  ).filter((t) => t.category === 'send' && t.address === address);
  const txids = new Set(sent.map((t) => t.txid));
  console.log(`server lockups to ${address}: ${[...txids].join(', ')}`);
  return txids.size;
};

run('B5: backend crash recovery', () => {
  jest.setTimeout(900_000);

  beforeAll(async () => {
    await ensureUserWallets();
    await crash();
    await start();
    console.log(`backend started by the test, log: ${LOG}`);
  });

  // If a test fails while the backend is down, the next one still starts clean
  beforeEach(async () => {
    if (!(await apiUp())) await start();
  });

  afterAll(stop);

  test('1. user locks while the backend is down: backend locks once on restart', async () => {
    const swap = await createSwap('BTC', 'XBT');
    await crash();

    const userLock = await lockUser(swap);
    await mine(SHA, 2);
    await start();

    await waitFor(swap.id, 'transaction.server.mempool', SHA);
    const lock = await serverLockup(swap);
    console.log(`server XBT lockup after restart: ${lock.id}`);
    await mine(BLAKE);
    await waitFor(swap.id, 'transaction.server.confirmed', BLAKE);

    const claim = await userClaim(swap);
    await rpc(BLAKE, 'sendrawtransaction', [claim.hex], '');
    await mine(BLAKE);
    await waitFor(swap.id, 'transaction.claimed', SHA);

    // Exactly one server lockup sent to this swap's HTLC on XBT
    expect(await serverLockupsTo(swap.claimDetails.lockupAddress)).toBe(1);
    expect((await spendsOf(SHA, userLock)).length).toBe(1);
  });

  test('2. user claims while the backend is down: backend claims the BTC on restart', async () => {
    const swap = await createSwap('BTC', 'XBT');
    const userLock = await lockUser(swap);
    await waitFor(swap.id, 'transaction.server.mempool', SHA);
    const before = await serverLockup(swap);
    await mine(BLAKE);
    await waitFor(swap.id, 'transaction.server.confirmed', BLAKE);
    await crash();

    // The backend is down, so claim from the lockup we already fetched
    const claim = await userClaim(swap, before);
    console.log(
      `user XBT claim while down: ${await rpc(BLAKE, 'sendrawtransaction', [claim.hex], '')}`,
    );
    await mine(BLAKE, 3);
    await start();

    await waitFor(swap.id, 'transaction.claimed', SHA);
    const after = await serverLockup(swap);
    expect(after.id).toBe(before.id);
    expect(await serverLockupsTo(swap.claimDetails.lockupAddress)).toBe(1);

    const serverClaim = parseTx(await findSpend(SHA, userLock));
    console.log(
      `server BTC claim after restart ${serverClaim.id}: ${describeSigs(serverClaim)}`,
    );
    expect(await spendsOf(SHA, userLock)).toHaveLength(1);
    // A BTC-side spend must never be valid on the BLAKE2b chain
    expect((await accept(BLAKE, serverClaim.hex)).allowed).toBe(false);
    await mine(SHA);
  });

  test('3. XBT timeout passes while the backend is down: backend refunds on restart, signed 0x21', async () => {
    const swap = await createSwap('BTC', 'XBT');
    const userLock = await lockUser(swap);
    await waitFor(swap.id, 'transaction.server.mempool', SHA);
    const lock = await serverLockup(swap);
    await mine(BLAKE);
    await waitFor(swap.id, 'transaction.server.confirmed', BLAKE);
    await crash();

    await mineTo(BLAKE, swap.claimDetails.timeoutBlockHeight + 1);
    console.log(
      `XBT at ${swap.claimDetails.timeoutBlockHeight + 1} while down; swap was ${await status(swap.id).catch(() => 'n/a (backend down)')}`,
    );
    await start();

    await waitFor(swap.id, 'transaction.refunded', BLAKE, ['swap.expired']);
    const refund = parseTx(await findSpend(BLAKE, lock.id));
    console.log(
      `server XBT refund after restart ${refund.id}: ${describeSigs(refund)}`,
    );
    const sig = refund.getInput(0).finalScriptWitness![0];
    expect(sig).toHaveLength(65);
    expect(sig[64]).toBe(UNIFIED);
    expect(await spendsOf(BLAKE, lock.id)).toHaveLength(1);
    // The backend has no preimage, so it must not have touched the user's BTC
    expect(await spendsOf(SHA, userLock)).toHaveLength(0);

    await mine(BLAKE);
    await mineTo(SHA, swap.lockupDetails.timeoutBlockHeight);
    const userBack = await userRefund(swap, userLock);
    await rpc(SHA, 'sendrawtransaction', [userBack.hex], '');
    await mine(SHA);
  });
});
