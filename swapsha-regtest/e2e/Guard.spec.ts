/**
 * D26 live check: the backend refuses to start when a provider wallet holds a
 * coin that can also exist on the other chain, and starts when it does not.
 *
 * Uses throwaway wallets so the real "swapsha" wallets stay clean:
 *   A. BTC wallet = "prefork": pre-fork coinbases. Refused.
 *   B. BTC wallet = "guard-tainted": one coin received AFTER the fork from a
 *      pre-fork coin, signed the old way. Its height passes a height-only
 *      check, but the deposit is replayable onto XBT. Refused by the ancestry
 *      walk. Then the deposit is actually replayed onto XBT and the backend
 *      is refused again, this time by the direct lookup on the other chain.
 *   C. XBT wallet = "guard-optin": one coin received from a pre-fork coin,
 *      signed with SIGHASH_UNIFIED by the Knots wallet. Unique to XBT. Starts.
 *   D. The same gap on the user side (D18): a BTC lockup funded from a
 *      replayable deposit that has not been replayed yet. XBT says
 *      missing-inputs, which the first D18 check treated as safe. The
 *      ancestry walk refuses it.
 *
 * This test runs the backend itself. Any backend already running (run.sh) is
 * killed at the start. Restart run.sh afterwards.
 *
 * Run from swapsha-backend, chains up:
 *   SWAPSHA_GUARD=1 npx jest --rootDir . swapsha-regtest/e2e/Guard.spec.ts --runInBand
 */
import {
  StartupRefused,
  configWithWallet,
  crash,
  start,
  stop,
} from './backend';
import {
  BLAKE,
  SHA,
  accept,
  api,
  createSwap,
  ensureUserWallets,
  height,
  mine,
  mineTo,
  rpc,
  waitFor,
} from './helpers';

const FORK = 200;
// Strip the logger's terminal colours from captured lines
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const run = process.env.SWAPSHA_GUARD === '1' ? describe : describe.skip;

const loadOrCreate = async (nodePort: number, wallet: string) => {
  try {
    await rpc(nodePort, 'loadwallet', [wallet], '');
  } catch {
    try {
      await rpc(nodePort, 'createwallet', [wallet], '');
    } catch {
      // already loaded
    }
  }
};

/**
 * Send `amount` from one pre-fork coin of the "prefork" wallet on `nodePort`,
 * signed by the wallet the normal way. The coin is chosen so that it is still
 * unspent on `alsoOn` too, which makes the outcome there depend only on the
 * signature.
 */
const sendPreForkCoin = async (
  nodePort: number,
  to: string,
  amount: number,
  alsoOn: number,
) => {
  const tip = await height(nodePort);
  const candidates = (
    await rpc<
      { txid: string; vout: number; amount: number; confirmations: number }[]
    >(nodePort, 'listunspent', [1], 'prefork')
  ).filter((u) => tip - u.confirmations + 1 < FORK && u.amount > amount + 0.01);
  let coin: (typeof candidates)[number] | undefined;
  for (const c of candidates) {
    if (
      (await rpc<unknown>(alsoOn, 'gettxout', [c.txid, c.vout, true], '')) !==
      null
    ) {
      coin = c;
      break;
    }
  }
  if (coin === undefined)
    throw new Error(
      `no pre-fork coin in prefork on ${nodePort} that is also unspent on ${alsoOn}`,
    );
  const { hex: raw } = await rpc<{ hex: string }>(
    nodePort,
    'send',
    [
      [{ [to]: amount }],
      null,
      'unset',
      10,
      {
        inputs: [{ txid: coin.txid, vout: coin.vout }],
        add_inputs: false,
        add_to_wallet: false,
      },
    ],
    'prefork',
  );
  const txid = await rpc<string>(nodePort, 'sendrawtransaction', [raw], '');
  await mine(nodePort);
  console.log(
    `sent ${amount} from pre-fork coin ${coin.txid}:${coin.vout} on ${nodePort}: ${txid}`,
  );
  return { txid, raw };
};

/** Empty `wallet` on `nodePort` into the "user" wallet, so reruns start clean. */
const drain = async (nodePort: number, wallet: string) => {
  const balance = await rpc<number>(nodePort, 'getbalance', [], wallet);
  if (balance <= 0) return;
  await rpc(
    nodePort,
    'sendtoaddress',
    [await rpc<string>(nodePort, 'getnewaddress'), balance, '', '', true],
    wallet,
  );
  await mine(nodePort);
};

const expectRefused = async (configPath: string, pattern: RegExp) => {
  try {
    await start(configPath);
  } catch (error) {
    expect(error).toBeInstanceOf(StartupRefused);
    const line = (error as StartupRefused).log
      .split('\n')
      .find((l) => /Could not (initialize|start) Boltz/.test(l));
    console.log(`refused: ${line?.replace(ANSI, '')}`);
    expect(line).toMatch(pattern);
    return;
  }
  await stop();
  throw new Error(`backend started with ${configPath}, expected a refusal`);
};

run('D26: provider wallet guard, live', () => {
  jest.setTimeout(300_000);

  beforeAll(async () => {
    await ensureUserWallets();
    await crash();
    await loadOrCreate(SHA, 'prefork');
    await loadOrCreate(BLAKE, 'prefork');
  });

  afterAll(stop);

  test('A. pre-fork coinbases in the BTC wallet: refused', async () => {
    await expectRefused(
      configWithWallet('BTC', 'prefork'),
      // The direct lookup usually fires first: the coinbase is on XBT too
      /BTC wallet coin .* (before the fork|also exists on the XBT chain)/,
    );
  });

  test('B. post-fork deposit from a pre-fork coin, signed the old way: refused, then refused again once replayed', async () => {
    await loadOrCreate(SHA, 'guard-tainted');
    await drain(SHA, 'guard-tainted');
    const to = await rpc<string>(SHA, 'getnewaddress', [], 'guard-tainted');
    const deposit = await sendPreForkCoin(SHA, to, 1, BLAKE);

    // The risk is real: the same deposit is valid on the BLAKE2b chain
    expect((await accept(BLAKE, deposit.raw)).allowed).toBe(true);

    await expectRefused(
      configWithWallet('BTC', 'guard-tainted'),
      /can exist on the XBT chain too/,
    );

    // Replay it for real, then the direct lookup on XBT catches it
    await rpc(BLAKE, 'sendrawtransaction', [deposit.raw], '');
    await mine(BLAKE);
    await expectRefused(
      configWithWallet('BTC', 'guard-tainted'),
      /also exists on the XBT chain/,
    );

    await drain(SHA, 'guard-tainted');
  });

  test('C. XBT deposit from a pre-fork coin, signed with SIGHASH_UNIFIED: starts', async () => {
    await loadOrCreate(BLAKE, 'guard-optin');
    await drain(BLAKE, 'guard-optin');
    const to = await rpc<string>(
      BLAKE,
      'getnewaddress',
      ['', 'bech32'],
      'guard-optin',
    );
    const deposit = await sendPreForkCoin(BLAKE, to, 1, SHA);

    // Opted in, so it is invalid on SHA-256 even though its input exists
    // there. The wallet sets nLockTime to the XBT tip, so bring SHA-256 past
    // it first; otherwise SHA-256 says non-final before checking the script.
    await mineTo(SHA, (await height(BLAKE)) + 1);
    const onSha = await accept(SHA, deposit.raw);
    console.log(`opt-in deposit on SHA-256: ${JSON.stringify(onSha)}`);
    expect(onSha.allowed).toBe(false);
    expect(onSha['reject-reason']).toMatch(/script-verify|signature|sig/i);

    const log = await start(configWithWallet('XBT', 'guard-optin'));
    const line = log
      .split('\n')
      .find((l) => /XBT wallet: .* unique to this chain/.test(l));
    console.log(`started: ${line?.replace(ANSI, '')}`);
    expect(line).toBeDefined();
    await stop();

    await drain(BLAKE, 'guard-optin');
  });

  test('D. D18: user lockup funded from a replayable, not yet replayed, deposit: refused', async () => {
    await loadOrCreate(SHA, 'guard-user');
    await drain(SHA, 'guard-user');
    const deposit = await sendPreForkCoin(
      SHA,
      await rpc<string>(SHA, 'getnewaddress', [], 'guard-user'),
      1,
      BLAKE,
    );
    expect((await accept(BLAKE, deposit.raw)).allowed).toBe(true);

    await start();
    const swap = await createSwap('BTC', 'XBT');
    const lockId = await rpc<string>(
      SHA,
      'sendtoaddress',
      [swap.lockupDetails.lockupAddress, swap.lockupDetails.amount / 1e8],
      'guard-user',
    );
    const lockHex = await rpc<string>(SHA, 'getrawtransaction', [lockId], '');
    // What the first D18 check saw: inputs missing on XBT, so "safe"
    const onXbt = await accept(BLAKE, lockHex);
    console.log(`lockup ${lockId} on XBT: ${JSON.stringify(onXbt)}`);
    expect(onXbt['reject-reason']).toMatch(/missing-inputs/);
    await mine(SHA);

    await waitFor(swap.id, 'transaction.lockupFailed', SHA, [
      'transaction.lockupFailed',
    ]);
    const info = await api<{ failureReason?: string }>(`/swap/${swap.id}`);
    console.log(`D18 refusal: ${info.failureReason}`);
    expect(info.failureReason).toMatch(
      /REPLAY_FLAGGED.*once its ancestry is replayed/,
    );
    await stop();

    await drain(SHA, 'guard-user');
  });
});
