/**
 * A4b-2: a restore that recovers open swaps (blueprint 6.5), against the
 * StartOS package in test mode on testnet4 only.
 *
 * Two runs with the restore in between, done by hand in StartOS:
 *
 *   before  a SHA256 to BTC chain swap up to SwapSha's BTC lockup confirmed,
 *           then a type 2 swap up to SwapSha's SHA-256 lockup confirmed with
 *           the hold invoice accepted. Everything the user side needs later
 *           (keys, preimages, lockups) is saved to restore-test.json. It
 *           prints the steps: back up SwapSha, uninstall, restore, start, and
 *           read the API port again (it changed at the A4a reinstall).
 *   after   SWAPSHA_RESTORE_FILE=<that file> and SWAPSHA_API with the port
 *           now shown. The restored backend must know both swaps where they
 *           were left; the user claims the type 2 SHA-256 and SwapSha must
 *           settle the hold invoice still held on the Mac's provider node;
 *           the user claims the chain swap's BTC (0x21) and SwapSha must
 *           claim the user's SHA-256 lockup with keys from the restored
 *           seed.dat, plainly signed and invalid on BTC.
 *
 * Run from swapsha-backend:
 *   SWAPSHA_NET=testnet4 SWAPSHA_API=https://192.168.4.21:<port>/v2 \
 *   NODE_OPTIONS=--use-system-ca npx jest --rootDir . \
 *   swapsha-regtest/e2e/Restore.spec.ts --runInBand -t "before"
 * then the same with SWAPSHA_RESTORE_FILE set and -t "after".
 */
import { hex } from '@scure/base';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CreatedSwap } from './helpers';
import {
  BLAKE,
  LIVE,
  SHA,
  TEST_TIMEOUT,
  createSwap,
  describeSigs,
  ensureUserWallets,
  expectInvalidOn,
  findSpend,
  lockUser,
  mine,
  parseTx,
  rpc,
  serverLockup,
  status,
  userClaim,
  waitFor,
} from './helpers';
import type { ReverseSwap } from './ln';
import {
  createReverse,
  invoiceState,
  payAsync,
  reverseLockup,
  stopPayments,
} from './ln';
import { saveUserRefund } from './refundKeys';

const UNIFIED = 0x21;
const STATE = join(
  homedir(),
  'Claude',
  'swapsha',
  'testnet4',
  'restore-test.json',
);

type Lock = { id: string; hex: string };

type State = {
  chain: { swap: CreatedSwap; userLock: string; serverLock: Lock };
  reverse: { swap: ReverseSwap; lock: Lock };
};

const BYTES = ['claimKey', 'refundKey', 'preimage'] as const;

const toJson = <T extends CreatedSwap>(swap: T) => ({
  ...swap,
  ...Object.fromEntries(BYTES.map((k) => [k, hex.encode(swap[k])])),
});

const fromJson = <T extends CreatedSwap>(json: Record<string, unknown>) =>
  ({
    ...json,
    ...Object.fromEntries(BYTES.map((k) => [k, hex.decode(json[k] as string)])),
  }) as unknown as T;

const saveState = async (state: State) => {
  await writeFile(
    STATE,
    `${JSON.stringify(
      {
        chain: { ...state.chain, swap: toJson(state.chain.swap) },
        reverse: { ...state.reverse, swap: toJson(state.reverse.swap) },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return STATE;
};

const loadState = async (file: string): Promise<State> => {
  const json = JSON.parse(await readFile(file, 'utf8')) as {
    chain: Omit<State['chain'], 'swap'> & { swap: Record<string, unknown> };
    reverse: Omit<State['reverse'], 'swap'> & { swap: Record<string, unknown> };
  };
  return {
    chain: { ...json.chain, swap: fromJson<CreatedSwap>(json.chain.swap) },
    reverse: {
      ...json.reverse,
      swap: fromJson<ReverseSwap>(json.reverse.swap),
    },
  };
};

/** The "after" run: both swaps must finish on the restored backend. */
const afterRestore = async (file: string) => {
  const { chain, reverse } = await loadState(file);

  // The restored database knows both, where they were left
  expect(await status(chain.swap.id)).toBe('transaction.server.confirmed');
  expect(await status(reverse.swap.id)).toBe('transaction.confirmed');
  expect(await invoiceState('prov', reverse.swap.paymentHash)).toBe('ACCEPTED');

  // Type 2 first: its SHA-256 timeout is the nearer one. SwapSha must
  // settle the hold invoice with the preimage from the user's claim.
  const claim = await userClaim(reverse.swap, reverse.lock);
  console.log(
    `user SHA256 claim of ${reverse.swap.id}: ${await rpc(SHA, 'sendrawtransaction', [claim.hex], '')}`,
  );
  await mine(SHA);
  await waitFor(reverse.swap.id, 'invoice.settled', SHA);
  expect(await invoiceState('prov', reverse.swap.paymentHash)).toBe('SETTLED');

  // Chain swap: the user claims the BTC, and SwapSha claims the
  // user's SHA-256 lockup with its key from the restored seed.dat
  const btcClaim = await userClaim(chain.swap, chain.serverLock);
  const sig = btcClaim.getInput(0).finalScriptWitness![0];
  expect(sig).toHaveLength(65);
  expect(sig[64]).toBe(UNIFIED);
  console.log(
    `user BTC claim of ${chain.swap.id}: ${await rpc(BLAKE, 'sendrawtransaction', [btcClaim.hex], '')}`,
  );
  await mine(BLAKE);
  await waitFor(chain.swap.id, 'transaction.claimed', SHA);

  const serverClaim = parseTx(await findSpend(SHA, chain.userLock));
  console.log(
    `server SHA256 claim ${serverClaim.id}: ${describeSigs(serverClaim)}`,
  );
  expect(serverClaim.getInput(0).finalScriptWitness![0]).toHaveLength(64);
  await expectInvalidOn(BLAKE, serverClaim.hex);
};

(LIVE ? describe : describe.skip)(
  'A4b-2: open swaps across a backup and restore of SwapSha (testnet4)',
  () => {
    jest.setTimeout(TEST_TIMEOUT);

    afterAll(stopPayments);

    test('before: a chain swap and a type 2 swap left open for the restore', async () => {
      await ensureUserWallets();

      // The chain swap first: its BTC lockup needs a BTC block, the slow one
      const chain = await createSwap('SHA256', 'BTC');
      await saveUserRefund(chain);
      const userLock = await lockUser(chain);
      await saveUserRefund(chain, userLock);
      await waitFor(chain.id, 'transaction.server.mempool', SHA);
      const serverLock = await serverLockup(chain);
      await mine(BLAKE);
      await waitFor(chain.id, 'transaction.server.confirmed', BLAKE);

      // Then the type 2 swap, so its nearer SHA-256 timeout starts last.
      // The payment stays in flight on the user's node after this run ends.
      const reverse = await createReverse();
      payAsync(reverse.invoice);
      await waitFor(reverse.id, 'transaction.mempool');
      expect(await invoiceState('prov', reverse.paymentHash)).toBe('ACCEPTED');
      const lock = await reverseLockup(reverse.id);
      await mine(SHA);
      await waitFor(reverse.id, 'transaction.confirmed', SHA);

      const file = await saveState({
        chain: { swap: chain, userLock, serverLock },
        reverse: { swap: reverse, lock },
      });
      console.log(
        [
          'Both swaps are open:',
          `  chain swap ${chain.id}: SwapSha's BTC lockup ${serverLock.id}, its timeout BTC block ${chain.claimDetails.timeoutBlockHeight}`,
          `  type 2 swap ${reverse.id}: SwapSha's SHA-256 lockup ${lock.id}, its timeout SHA-256 block ${reverse.claimDetails.timeoutBlockHeight}`,
          `State saved to ${file}.`,
          'Now, well before that SHA-256 block:',
          '  1. Export Rescue Data: both swaps listed.',
          '  2. Back up SwapSha in StartOS.',
          '  3. Uninstall SwapSha.',
          '  4. Restore SwapSha from that backup and start it.',
          "  5. Read the API's LAN address in SwapSha's Interfaces; the port may have changed.",
          '  6. Run this suite with -t "after", SWAPSHA_RESTORE_FILE set to the file above and SWAPSHA_API to that address.',
        ].join('\n'),
      );
    });

    (process.env.SWAPSHA_RESTORE_FILE ? test : test.skip)(
      'after: both swaps finish on the restored SwapSha',
      () => afterRestore(process.env.SWAPSHA_RESTORE_FILE!),
    );
  },
);
