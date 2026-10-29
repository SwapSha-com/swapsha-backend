/**
 * B5: end-to-end chain swaps against the running SwapSha backend.
 *
 * Needs, all running:
 *   ~/Claude/swapsha/regtest/swapsha_regtest.sh start   (+ `provider` done once)
 *   ./swapsha-regtest/run.sh                              (backend + sidecar)
 *
 * Run from swapsha-backend:
 *   npx jest --rootDir . swapsha-regtest/e2e --runInBand
 *
 * The user side is played by these tests. Every check that matters for
 * replay protection is on the XBT side: whatever is signed there (by the user,
 * by the backend's Knots wallet, or by the backend's swap code) must carry
 * SIGHASH_UNIFIED, 0x21.
 */
import {
  BLAKE,
  SHA,
  accept,
  createSwap,
  ensureUserWallets,
  findSpend,
  hashTypes,
  lockUser,
  mine,
  mineTo,
  parseTx,
  port,
  rpc,
  serverLockup,
  userClaim,
  userRefund,
  waitFor,
} from './helpers';

const UNIFIED = 0x21;
const LEGACY = 0x01;

describe('B5: chain swaps between BTC (SHA-256) and XBT (BLAKE2b)', () => {
  jest.setTimeout(600_000);

  beforeAll(ensureUserWallets);

  test('BTC -> XBT completes with a replay-protected XBT claim', async () => {
    const swap = await createSwap('BTC', 'XBT');
    await lockUser(swap);

    await waitFor(swap.id, 'transaction.server.mempool', SHA);
    const lock = await serverLockup(swap);
    console.log(`server XBT lockup: ${lock.id}`);
    // The backend's Knots wallet opted in on every input
    expect(hashTypes(parseTx(lock.hex)).every((t) => t === UNIFIED)).toBe(true);
    expect((await accept(SHA, lock.hex)).allowed).toBe(false);

    await mine(BLAKE);
    await waitFor(swap.id, 'transaction.server.confirmed', BLAKE);

    const claim = await userClaim(swap);
    expect(claim.getInput(0).finalScriptWitness![0]).toHaveLength(65);
    console.log(
      `user XBT claim: ${await rpc(BLAKE, 'sendrawtransaction', [claim.hex], '')}`,
    );
    await mine(BLAKE);

    await waitFor(swap.id, 'transaction.claimed', SHA);
  });

  test('XBT -> BTC completes, and the backend claims the XBT with 0x21', async () => {
    const swap = await createSwap('XBT', 'BTC');
    const userLock = await lockUser(swap);
    // The user's Knots wallet opted in as well
    const userLockHex = await rpc<string>(
      BLAKE,
      'getrawtransaction',
      [userLock],
      '',
    );
    expect(hashTypes(parseTx(userLockHex)).every((t) => t === UNIFIED)).toBe(
      true,
    );

    await waitFor(swap.id, 'transaction.server.mempool', BLAKE);
    const lock = await serverLockup(swap);
    console.log(`server BTC lockup: ${lock.id}`);
    // BTC side: ordinary signatures, but funded from post-fork coins, so the
    // lockup cannot exist on the BLAKE2b chain
    expect(hashTypes(parseTx(lock.hex)).every((t) => t === LEGACY)).toBe(true);
    const lockOnBlake = await accept(BLAKE, lock.hex);
    expect(lockOnBlake.allowed).toBe(false);
    expect(lockOnBlake['reject-reason']).toMatch(/missing-inputs/);

    await mine(SHA);
    await waitFor(swap.id, 'transaction.server.confirmed', SHA);

    const claim = await userClaim(swap);
    console.log(
      `user BTC claim: ${await rpc(SHA, 'sendrawtransaction', [claim.hex], '')}`,
    );
    await mine(SHA);

    await waitFor(swap.id, 'transaction.claimed', BLAKE);
    const serverClaim = parseTx(await findSpend(BLAKE, userLock));
    console.log(`server XBT claim: ${serverClaim.id}`);
    const sig = serverClaim.getInput(0).finalScriptWitness![0];
    expect(sig).toHaveLength(65);
    expect(sig[64]).toBe(UNIFIED);
  });

  test('user refunds an underpaid XBT lockup after the timeout, signed 0x21', async () => {
    const swap = await createSwap('XBT', 'BTC');
    const userLock = await lockUser(swap, swap.lockupDetails.amount - 20_000);
    await waitFor(swap.id, 'transaction.lockupFailed', BLAKE, [
      'transaction.lockupFailed',
    ]);

    await mineTo(BLAKE, swap.lockupDetails.timeoutBlockHeight);
    const refund = await userRefund(swap, userLock);
    const sig = refund.getInput(0).finalScriptWitness![0];
    expect(sig).toHaveLength(65);
    expect(sig[64]).toBe(UNIFIED);
    expect(await accept(BLAKE, refund.hex)).toMatchObject({ allowed: true });
    console.log(
      `user XBT refund: ${await rpc(BLAKE, 'sendrawtransaction', [refund.hex], '')}`,
    );
    await mine(BLAKE);
  });

  test('backend refunds its XBT lockup when the user never claims, signed 0x21', async () => {
    const swap = await createSwap('BTC', 'XBT');
    const userLock = await lockUser(swap);
    await waitFor(swap.id, 'transaction.server.mempool', SHA);
    const lock = await serverLockup(swap);
    await mine(BLAKE);
    await waitFor(swap.id, 'transaction.server.confirmed', BLAKE);

    // Run the XBT side past the backend's timeout without claiming
    await mineTo(BLAKE, swap.claimDetails.timeoutBlockHeight + 1);
    await waitFor(swap.id, 'transaction.refunded', BLAKE, ['swap.expired']);

    const serverRefund = parseTx(await findSpend(BLAKE, lock.id));
    console.log(`server XBT refund: ${serverRefund.id}`);
    expect(hashTypes(serverRefund).every((t) => t === UNIFIED)).toBe(true);

    // The user still gets their BTC back after their own (longer) timeout
    await mineTo(port('BTC'), swap.lockupDetails.timeoutBlockHeight);
    const refund = await userRefund(swap, userLock);
    console.log(
      `user BTC refund: ${await rpc(SHA, 'sendrawtransaction', [refund.hex], '')}`,
    );
    await mine(SHA);
  });
});
