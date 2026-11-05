/**
 * Phase 2 L4: end-to-end Lightning swaps against the running SwapSha backend.
 *
 *   Type 1 (submarine): the user locks Spamcoin (SHA256) on chain, SwapSha
 *     pays the user's BTC Lightning invoice and claims the Spamcoin.
 *   Type 2 (reverse): the user pays a BTC Lightning hold invoice, SwapSha
 *     locks Spamcoin, the user claims it and SwapSha settles the invoice.
 *
 * Plus the failure paths: type 1 refund after the timeout, type 2 refund and
 * cancel when the user never claims, type 2 hold invoice expiry, and the D29
 * refusal of an invoice that is not for the BLAKE2b Lightning network.
 *
 * Needs, all running:
 *   ~/Claude/swapsha/regtest/swapsha_regtest.sh start
 *   ~/Claude/swapsha/lightning/swapsha_ln_regtest.sh start   (channel and macaroon done once)
 *   ./swapsha-regtest/run.sh
 *
 * Run from swapsha-backend:
 *   npx jest --rootDir . swapsha-regtest/e2e/Lightning.spec.ts --runInBand
 */
import {
  BLAKE,
  SHA,
  TEST_TIMEOUT,
  accept,
  api,
  describeSigs,
  ensureUserWallets,
  expectInvalidOn,
  findSpend,
  lockUser,
  mine,
  mineTo,
  parseTx,
  rpc,
  sleep,
  status,
  userClaim,
  userRefund,
  waitFor,
} from './helpers';
import {
  craftedInvoice,
  createReverse,
  createSubmarine,
  invoiceFeatures,
  invoiceState,
  payAsync,
  reverseLockup,
  stopPayments,
  userInvoice,
} from './ln';

const OPTION_BLAKE2B = 512;

/** Wait up to `seconds` for a status that comes from a timer, not a block. */
const waitTimer = async (id: string, want: string, seconds: number) => {
  for (let i = 0; i < seconds / 5; i++) {
    if ((await status(id)) === want) return;
    await sleep(5000);
  }
  throw new Error(
    `swap ${id} at ${await status(id)} after ${seconds}s, wanted ${want}`,
  );
};

describe('L4: Lightning swaps between Spamcoin (SHA256) and BTC Lightning (Lightning Fork)', () => {
  jest.setTimeout(TEST_TIMEOUT);

  beforeAll(ensureUserWallets);
  afterAll(stopPayments);

  test('type 1: SHA256 on chain -> BTC Lightning completes', async () => {
    const { invoice, paymentHash } = await userInvoice(100_000);
    expect(await invoiceFeatures(invoice)).toContain(OPTION_BLAKE2B);

    const swap = await createSubmarine(invoice);
    const userLock = await lockUser(swap);
    await waitFor(swap.id, 'transaction.claimed', SHA);

    expect(await invoiceState('user', paymentHash)).toBe('SETTLED');
    const serverClaim = parseTx(await findSpend(SHA, userLock));
    console.log(
      `server SHA256 claim ${serverClaim.id}: ${describeSigs(serverClaim)}`,
    );
    // Spends coins that exist on the SHA-256 chain only
    await expectInvalidOn(BLAKE, serverClaim.hex);
    await mine(SHA);
  });

  test('type 1: user refunds an underpaid SHA256 lockup after the timeout; invoice not paid', async () => {
    const { invoice, paymentHash } = await userInvoice(100_000);
    const swap = await createSubmarine(invoice);
    const userLock = await lockUser(swap, swap.lockupDetails.amount - 20_000);
    await waitFor(swap.id, 'transaction.lockupFailed', SHA, [
      'transaction.lockupFailed',
    ]);
    const info = await api<{ failureReason?: string }>(`/swap/${swap.id}`);
    console.log(`lockup refused: ${info.failureReason}`);
    expect(await invoiceState('user', paymentHash)).toBe('OPEN');

    await mineTo(SHA, swap.lockupDetails.timeoutBlockHeight);
    const refund = await userRefund(swap, userLock);
    expect(await accept(SHA, refund.hex)).toMatchObject({ allowed: true });
    console.log(
      `user SHA256 refund: ${await rpc(SHA, 'sendrawtransaction', [refund.hex], '')}`,
    );
    await mine(SHA);
    expect(await invoiceState('user', paymentHash)).toBe('OPEN');
  });

  test('type 2: BTC Lightning -> SHA256 on chain completes and the hold invoice settles', async () => {
    const swap = await createReverse();
    expect(await invoiceFeatures(swap.invoice)).toContain(OPTION_BLAKE2B);
    const payment = payAsync(swap.invoice);

    // No mining here, or the lockup confirms before we see it in the mempool
    await waitFor(swap.id, 'transaction.mempool');
    expect(await invoiceState('prov', swap.paymentHash)).toBe('ACCEPTED');
    const lock = await reverseLockup(swap.id);
    console.log(
      `server SHA256 lockup ${lock.id}: ${describeSigs(parseTx(lock.hex))}`,
    );
    // Funded from post-fork coins, so it cannot exist on the BLAKE2b chain
    await expectInvalidOn(BLAKE, lock.hex);

    await mine(SHA);
    await waitFor(swap.id, 'transaction.confirmed', SHA);
    const claim = await userClaim(swap, lock);
    console.log(
      `user SHA256 claim: ${await rpc(SHA, 'sendrawtransaction', [claim.hex], '')}`,
    );
    await mine(SHA);

    await waitFor(swap.id, 'invoice.settled', SHA);
    expect(await payment.result).toMatch(/^SUCCEEDED/);
    expect(await invoiceState('prov', swap.paymentHash)).toBe('SETTLED');
  });

  test('type 2: user never claims; SwapSha refunds its SHA256 and cancels the hold invoice', async () => {
    const swap = await createReverse();
    const payment = payAsync(swap.invoice);
    await waitFor(swap.id, 'transaction.mempool');
    const lock = await reverseLockup(swap.id);
    await mine(SHA);
    await waitFor(swap.id, 'transaction.confirmed', SHA);

    await mineTo(SHA, swap.claimDetails.timeoutBlockHeight);
    await waitFor(swap.id, 'transaction.refunded', SHA, ['swap.expired']);

    const refund = parseTx(await findSpend(SHA, lock.id));
    console.log(`server SHA256 refund ${refund.id}: ${describeSigs(refund)}`);
    await expectInvalidOn(BLAKE, refund.hex);
    // The user's BTC comes back: the payment fails and the invoice is cancelled
    expect(await payment.result).toMatch(/^FAILED/);
    expect(await invoiceState('prov', swap.paymentHash)).toBe('CANCELED');
    await mine(SHA);
  });

  test('type 2: an unpaid hold invoice expires and cannot be paid afterwards', async () => {
    // 60 seconds is the shortest expiry Boltz allows
    const swap = await createReverse(100_000, 60);
    // The expiry check runs every 60 seconds
    await waitTimer(swap.id, 'invoice.expired', 240);
    expect(await invoiceState('prov', swap.paymentHash)).toBe('CANCELED');

    const late = await payAsync(swap.invoice).result;
    expect(late).toMatch(/^FAILED/);
    // Nothing was locked on chain
    await expect(reverseLockup(swap.id)).rejects.toThrow();
  });

  test('D29: refuses an invoice that is not for the BLAKE2b Lightning network', async () => {
    const spamcoin = craftedInvoice(100_000);
    await expect(createSubmarine(spamcoin)).rejects.toThrow(/option_blake2b/);

    // Control: the same kind of invoice with bit 512 set gets past D29 (it
    // may still fail later, for example on routing to a node that does not exist)
    let control = 'created';
    try {
      await createSubmarine(craftedInvoice(100_000, true));
    } catch (e) {
      control = (e as Error).message;
    }
    console.log(`control invoice with bit 512: ${control}`);
    expect(control).not.toMatch(/option_blake2b/);
  });
});
