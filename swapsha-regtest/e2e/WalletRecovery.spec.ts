/**
 * D40, second amendment (Nov 10) on real nodes: a seed wallet that was lost
 * and made again blank from the seed gets its coins back. Regtest only, no
 * backend. Each run uses a fresh account of its own test seed.
 *
 * The SHA256 node must be pruned, with blockfilterindex and an archival peer
 * to fetch pruned blocks from: the D38 V2 setup,
 *   ./swapsha_regtest.sh prune-sha
 * There the filters path runs (scanblocks, getblockfrompeer, a rescan of each
 * block); on the archival BLAKE2b node the rescan path runs.
 *
 *   npx jest --rootDir . swapsha-regtest/e2e/WalletRecovery.spec.ts --runInBand
 */
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import {
  bip32VersionsFor,
  ensureSeedWallet,
  recoverSeedWallet,
} from '../../lib/blake2b/NodeWallets';
import { BLAKE, LIVE, SHA, ensureUserWallets, height, rpc } from './helpers';

// A BIP39 test vector, used only here: never the seed of SeedWallet.spec.ts
const MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const master = HDKey.fromMasterSeed(
  mnemonicToSeedSync(MNEMONIC),
  bip32VersionsFor('regtest'),
);

const run = LIVE ? describe.skip : describe;

const nodeFor = (symbol: 'BTC' | 'SHA256', nodePort: number, wallet: string) =>
  ({
    symbol,
    rpc: <T>(method: string, params?: unknown[]) =>
      rpc<T>(nodePort, method, params ?? [], ''),
    walletRpc: <T>(method: string, params?: unknown[]) =>
      rpc<T>(nodePort, method, params ?? [], wallet),
  }) as any;

const generate = async (nodePort: number, blocks: number) => {
  const address = await rpc<string>(nodePort, 'getnewaddress', ['', 'bech32']);
  for (let left = blocks; left > 0; left -= 100) {
    await rpc(
      nodePort,
      'generatetoaddress',
      [Math.min(100, left), address],
      '',
    );
  }
};

type Coin = { txid: string; vout: number; amount: number };

const coins = async (nodePort: number, wallet: string) =>
  (await rpc<Coin[]>(nodePort, 'listunspent', [1], wallet))
    .map((c) => `${c.txid}:${c.vout} ${c.amount}`)
    .sort();

const trusted = async (nodePort: number, wallet: string) =>
  (
    await rpc<{ mine: { trusted: number } }>(
      nodePort,
      'getbalances',
      [],
      wallet,
    )
  ).mine.trusted;

run('WalletRecovery (D40, regtest nodes)', () => {
  jest.setTimeout(600_000);

  const stamp = Date.now();
  const toUnload: [number, string][] = [];

  // The "user" wallets fund the test, as in the other suites
  beforeAll(ensureUserWallets);

  afterAll(async () => {
    for (const [nodePort, wallet] of toUnload) {
      await rpc(nodePort, 'unloadwallet', [wallet], '').catch(() => {});
    }
  });

  test.each([
    { symbol: 'SHA256' as const, nodePort: SHA, pruned: true },
    { symbol: 'BTC' as const, nodePort: BLAKE, pruned: false },
  ])(
    '$symbol: a lost seed wallet gets its coins back',
    async ({ symbol, nodePort, pruned }) => {
      const info = await rpc<{ pruned: boolean }>(
        nodePort,
        'getblockchaininfo',
        [],
        '',
      );
      if (info.pruned !== pruned) {
        throw new Error(
          `the ${symbol} node is ${info.pruned ? '' : 'not '}pruned; the SHA256 node needs ./swapsha_regtest.sh prune-sha first`,
        );
      }

      // A fresh account of the test seed for each run
      const account = 100 + (stamp % 1_000_000);
      const options = { account, network: 'regtest', master };
      const wallet = `recover_${symbol.toLowerCase()}_${stamp}`;
      toUnload.push([nodePort, wallet]);
      await ensureSeedWallet(nodeFor(symbol, nodePort, wallet), {
        ...options,
        wallet,
      });

      // History: three coins in, one spent back out
      const fromHeight = await height(nodePort);
      for (let i = 0; i < 3; i++) {
        await rpc(nodePort, 'sendtoaddress', [
          await rpc<string>(nodePort, 'getnewaddress', ['', 'bech32'], wallet),
          0.1,
        ]);
      }
      await generate(nodePort, 1);
      const funded = await rpc<string>(nodePort, 'getbestblockhash', [], '');
      await rpc(
        nodePort,
        'sendtoaddress',
        [await rpc<string>(nodePort, 'getnewaddress', ['', 'bech32']), 0.05],
        wallet,
      );
      await generate(nodePort, 1);

      const balance = await trusted(nodePort, wallet);
      const unspent = await coins(nodePort, wallet);
      expect(balance).toBeGreaterThan(0.2);

      if (pruned) {
        // Bury the history and prune it away (fastprune files are small)
        await generate(nodePort, 1_000);
        await rpc(
          nodePort,
          'pruneblockchain',
          [(await height(nodePort)) - 300],
          '',
        );
        await expect(
          rpc(nodePort, 'getblock', [funded, 0], ''),
        ).rejects.toThrow(/pruned/i);
      }

      // Lost: the same seed wallet made again, blank, under another name
      await rpc(nodePort, 'unloadwallet', [wallet], '');
      const again = `${wallet}_again`;
      toUnload.push([nodePort, again]);
      const node = nodeFor(symbol, nodePort, again);
      await ensureSeedWallet(node, { ...options, wallet: again });
      expect(await trusted(nodePort, again)).toEqual(0);

      const result = await recoverSeedWallet(node, {
        wallet: again,
        fromHeight,
      });
      console.log(`${symbol} recovery: ${JSON.stringify(result)}`);

      expect(result.mode).toEqual(pruned ? 'filters' : 'rescan');
      if (pruned) {
        // The funding and the spend
        expect(result.blocks).toBeGreaterThanOrEqual(2);
        expect(result.fetched).toBeGreaterThanOrEqual(1);
      }
      expect(await trusted(nodePort, again)).toEqual(balance);
      expect(await coins(nodePort, again)).toEqual(unspent);
    },
  );
});
