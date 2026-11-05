/**
 * Phase 2 L4: crash recovery and the D30 stall guard for the Lightning swaps.
 *
 * Crash (SIGKILL the backend, move the chains on, restart):
 *   1. Type 2: the user claims the Spamcoin (revealing the preimage) while the
 *      backend is down. Expect: on restart it finds the claim and settles the
 *      hold invoice. If it did not, it would lose the BTC at the HTLC timeout.
 *   2. Type 1: the user locks Spamcoin while the backend is down. Expect: on
 *      restart it pays the invoice once and claims the Spamcoin.
 *
 * Stall guard (a config with maxTipAgeMinutes = 1 on BTC, and BTC blocks
 * held back so its tip goes stale while SHA256 still moves):
 *   3. New Lightning swaps are refused with the stale-tip reason.
 *   4. A type 2 hold invoice paid during the stall: no Spamcoin is locked and
 *      the payment is given back at once.
 *   5. A type 1 lockup confirmed during the stall: the invoice is not paid
 *      until BTC moves again, then paid and claimed.
 *
 * This test runs the backend itself. Any backend already running (run.sh) is
 * killed at the start. Restart run.sh afterwards.
 *
 * Run from swapsha-backend, chains and both Lightning Fork nodes up:
 *   SWAPSHA_CRASH=1 npx jest --rootDir . swapsha-regtest/e2e/LightningCrash.spec.ts --runInBand
 */
import {
  LOG,
  apiUp,
  configWithPace,
  crash,
  freshConfig,
  start,
  stop,
} from './backend';
import {
  BLAKE,
  LIVE,
  SHA,
  TEST_TIMEOUT,
  api,
  ensureUserWallets,
  findSpend,
  lockUser,
  mine,
  rpc,
  sleep,
  status,
  userClaim,
  waitFor,
} from './helpers';
import {
  createReverse,
  createSubmarine,
  invoiceState,
  payAsync,
  reverseLockup,
  stopPayments,
  tipAge,
  userInvoice,
} from './ln';

// Needs mining (and holding blocks back), so regtest only
const run =
  process.env.SWAPSHA_CRASH === '1' && !LIVE ? describe : describe.skip;

const STALE = /BTC chain tip is \d+ minutes old/;

run('L4: Lightning crash recovery and stall guard', () => {
  jest.setTimeout(TEST_TIMEOUT);

  beforeAll(async () => {
    await ensureUserWallets([SHA]);
    await crash();
    freshConfig();
    await start();
    console.log(`backend started by the test, log: ${LOG}`);
  });

  afterAll(async () => {
    stopPayments();
    await stop();
  });

  describe('crash', () => {
    beforeEach(async () => {
      if (!(await apiUp())) await start();
    });

    test('1. type 2: user claims while the backend is down; hold invoice settles on restart', async () => {
      const swap = await createReverse();
      const payment = payAsync(swap.invoice);
      await waitFor(swap.id, 'transaction.mempool');
      const lock = await reverseLockup(swap.id);
      await mine(SHA);
      await waitFor(swap.id, 'transaction.confirmed', SHA);
      await crash();

      const claim = await userClaim(swap, lock);
      console.log(
        `user SHA256 claim while down: ${await rpc(SHA, 'sendrawtransaction', [claim.hex], '')}`,
      );
      await mine(SHA, 3);
      expect(await invoiceState('prov', swap.paymentHash)).toBe('ACCEPTED');
      await start();

      await waitFor(swap.id, 'invoice.settled', SHA);
      expect(await payment.result).toMatch(/^SUCCEEDED/);
      expect(await invoiceState('prov', swap.paymentHash)).toBe('SETTLED');
    });

    test('2. type 1: user locks while the backend is down; paid once and claimed on restart', async () => {
      const { invoice, paymentHash } = await userInvoice(100_000);
      const swap = await createSubmarine(invoice);
      await crash();

      const userLock = await lockUser(swap);
      await mine(SHA, 2);
      await start();

      await waitFor(swap.id, 'transaction.claimed', SHA);
      expect(await invoiceState('user', paymentHash)).toBe('SETTLED');
      const claim = await findSpend(SHA, userLock);
      console.log(
        `server SHA256 claim after restart: ${claim.slice(0, 16)}...`,
      );
      await mine(SHA);
    });
  });

  describe('D30 stall guard (BTC tip older than 1 minute)', () => {
    let reverse: Awaited<ReturnType<typeof createReverse>>;
    let submarine: Awaited<ReturnType<typeof createSubmarine>>;
    let submarineHash: string;

    beforeAll(async () => {
      await crash();
      await start(
        configWithPace('BTC', {
          fastMinutesPerBlock: 10,
          slowMinutesPerBlock: 10,
          maxTipAgeMinutes: 1,
        }),
      );
      // Fresh tip: these two swaps are created before the stall
      await mine(BLAKE);
      reverse = await createReverse();
      const inv = await userInvoice(100_000);
      submarineHash = inv.paymentHash;
      submarine = await createSubmarine(inv.invoice);

      // Hold BTC blocks back until its tip is safely past the limit
      while ((await tipAge(BLAKE)) < 90) await sleep(5000);
      console.log(`BTC tip is ${await tipAge(BLAKE)} seconds old`);
    });

    afterAll(async () => {
      // Back to the normal config for anything that runs after
      await crash();
      await start();
    });

    test('3. new Lightning swaps are refused while BTC is stale', async () => {
      await expect(createReverse()).rejects.toThrow(STALE);
      const { invoice } = await userInvoice(100_000);
      await expect(createSubmarine(invoice)).rejects.toThrow(STALE);
    });

    test('4. type 2 paid during the stall: nothing locked, payment given back', async () => {
      const payment = payAsync(reverse.invoice);
      expect(await payment.result).toMatch(/^FAILED/);
      await waitFor(reverse.id, 'transaction.failed');
      const info = await api<{ failureReason?: string }>(`/swap/${reverse.id}`);
      console.log(`type 2 during stall: ${info.failureReason}`);
      expect(info.failureReason).toMatch(STALE);
      expect(await invoiceState('prov', reverse.paymentHash)).toBe('CANCELED');
      await expect(reverseLockup(reverse.id)).rejects.toThrow();
    });

    test('5. type 1 confirmed during the stall: paid only after BTC moves', async () => {
      // Mining SHA256 does not move BTC, so the stall holds
      await lockUser(submarine);
      await waitFor(submarine.id, 'invoice.pending', SHA);
      // Several retry rounds (every 15 seconds) while still stale
      await sleep(40_000);
      expect(await status(submarine.id)).toBe('invoice.pending');
      expect(await invoiceState('user', submarineHash)).toBe('OPEN');

      await mine(BLAKE);
      await waitFor(submarine.id, 'transaction.claimed', SHA);
      expect(await invoiceState('user', submarineHash)).toBe('SETTLED');
      await mine(SHA);
    });
  });
});
