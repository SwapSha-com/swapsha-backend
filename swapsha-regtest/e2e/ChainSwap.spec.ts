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
 * The property every test checks: nothing the swap puts on one chain can be
 * valid on the other. HTLC spends signed by SwapSha's own code on the XBT side
 * always carry SIGHASH_UNIFIED (0x21). Wallet-funded transactions are safe
 * either because they opted in or because their coins exist on one chain only.
 */
import {
  BLAKE,
  SHA,
  accept,
  acceptWhenFinal,
  api,
  createSwap,
  describeSigs,
  ensureUserWallets,
  findSpend,
  lockUser,
  lockUserWithPreForkCoin,
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

const expectUnified = (witnessSig: Uint8Array) => {
  expect(witnessSig).toHaveLength(65);
  expect(witnessSig[64]).toBe(UNIFIED);
};

describe('B5: chain swaps between BTC (SHA-256) and XBT (BLAKE2b)', () => {
  jest.setTimeout(600_000);

  beforeAll(ensureUserWallets);

  test('BTC -> XBT completes with a replay-protected XBT claim', async () => {
    const swap = await createSwap('BTC', 'XBT');
    await lockUser(swap);

    await waitFor(swap.id, 'transaction.server.mempool', SHA);
    const lock = await serverLockup(swap);
    console.log(
      `server XBT lockup ${lock.id}: ${describeSigs(parseTx(lock.hex))}`,
    );
    expect((await accept(SHA, lock.hex)).allowed).toBe(false);

    await mine(BLAKE);
    await waitFor(swap.id, 'transaction.server.confirmed', BLAKE);

    const claim = await userClaim(swap);
    expectUnified(claim.getInput(0).finalScriptWitness![0]);
    console.log(
      `user XBT claim: ${await rpc(BLAKE, 'sendrawtransaction', [claim.hex], '')}`,
    );
    await mine(BLAKE);

    await waitFor(swap.id, 'transaction.claimed', SHA);
  });

  test('XBT -> BTC completes, and the backend claims the XBT with 0x21', async () => {
    const swap = await createSwap('XBT', 'BTC');
    const userLock = await lockUser(swap);
    const userLockHex = await rpc<string>(
      BLAKE,
      'getrawtransaction',
      [userLock],
      '',
    );
    console.log(
      `user XBT lockup ${userLock}: ${describeSigs(parseTx(userLockHex))}`,
    );
    expect((await accept(SHA, userLockHex)).allowed).toBe(false);

    await waitFor(swap.id, 'transaction.server.mempool', BLAKE);
    const lock = await serverLockup(swap);
    console.log(
      `server BTC lockup ${lock.id}: ${describeSigs(parseTx(lock.hex))}`,
    );
    // Funded from post-fork coins, so it cannot exist on the BLAKE2b chain
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
    console.log(
      `server XBT claim ${serverClaim.id}: ${describeSigs(serverClaim)}`,
    );
    expectUnified(serverClaim.getInput(0).finalScriptWitness![0]);
  });

  test('user refunds an underpaid XBT lockup after the timeout, signed 0x21', async () => {
    const swap = await createSwap('XBT', 'BTC');
    const userLock = await lockUser(swap, swap.lockupDetails.amount - 20_000);
    await waitFor(swap.id, 'transaction.lockupFailed', BLAKE, [
      'transaction.lockupFailed',
    ]);

    await mineTo(BLAKE, swap.lockupDetails.timeoutBlockHeight);
    const refund = await userRefund(swap, userLock);
    expectUnified(refund.getInput(0).finalScriptWitness![0]);
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

    await mineTo(BLAKE, swap.claimDetails.timeoutBlockHeight + 1);
    await waitFor(swap.id, 'transaction.refunded', BLAKE, ['swap.expired']);

    const serverRefund = parseTx(await findSpend(BLAKE, lock.id));
    console.log(
      `server XBT refund ${serverRefund.id}: ${describeSigs(serverRefund)}`,
    );
    expectUnified(serverRefund.getInput(0).finalScriptWitness![0]);

    await mineTo(port('BTC'), swap.lockupDetails.timeoutBlockHeight);
    const refund = await userRefund(swap, userLock);
    console.log(
      `user BTC refund: ${await rpc(SHA, 'sendrawtransaction', [refund.hex], '')}`,
    );
    await mine(SHA);
  });

  test('D18: backend refuses a BTC lockup that is replayable onto BLAKE2b', async () => {
    const swap = await createSwap('BTC', 'XBT');
    const { raw } = await lockUserWithPreForkCoin(swap);
    // Precondition: this lockup really is valid on the BLAKE2b chain
    expect((await acceptWhenFinal(BLAKE, raw)).allowed).toBe(true);

    await waitFor(swap.id, 'transaction.lockupFailed', SHA, [
      'transaction.lockupFailed',
    ]);
    const info = await api<{ failureReason?: string }>(`/swap/${swap.id}`);
    console.log(`D18 refusal: ${info.failureReason}`);
    expect(info.failureReason).toContain('REPLAY_FLAGGED');
    await expect(serverLockup(swap)).rejects.toThrow();
  });
});
