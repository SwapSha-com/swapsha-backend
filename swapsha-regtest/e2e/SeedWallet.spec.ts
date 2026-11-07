/**
 * D40 on real nodes: SwapSha's provider wallets derived from seed.dat.
 * Creates throwaway wallets on both regtest nodes, checks that the node hands
 * out the addresses the BIP84/BIP86 paths give, that a second start only
 * checks, and that a wallet with other keys is refused. No backend needed.
 *
 *   npx jest --rootDir . swapsha-regtest/e2e/SeedWallet.spec.ts --runInBand
 */
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { p2tr, p2wpkh } from '@scure/btc-signer';
import { Networks } from 'boltz-core';
import {
  bip32VersionsFor,
  descriptorChecksum,
  ensureSeedWallet,
  seedWalletDescriptors,
} from '../../lib/blake2b/NodeWallets';
import { BLAKE, LIVE, SHA, rpc } from './helpers';

// A test seed only, never funded
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
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

run('SeedWallet (D40, regtest nodes)', () => {
  jest.setTimeout(120_000);

  const stamp = Date.now();
  const cases = [
    { symbol: 'BTC' as const, nodePort: BLAKE, account: 0 },
    { symbol: 'SHA256' as const, nodePort: SHA, account: 1 },
  ];

  const toUnload: [number, string][] = [];

  afterAll(async () => {
    for (const [nodePort, wallet] of toUnload) {
      await rpc(nodePort, 'unloadwallet', [wallet], '').catch(() => {});
    }
  });

  test.each(cases)(
    '$symbol: creates the wallet, the node derives the D40 addresses',
    async ({ symbol, nodePort, account }) => {
      const wallet = `seedtest_${symbol.toLowerCase()}_${stamp}`;
      toUnload.push([nodePort, wallet]);
      const node = nodeFor(symbol, nodePort, wallet);
      const options = { wallet, account, network: 'regtest', master };

      await expect(ensureSeedWallet(node, options)).resolves.toEqual(
        `${symbol} node wallet "${wallet}" created, filled from seed.dat; matches seed.dat (84h and 86h, 1h/${account}h)`,
      );

      // A second start only checks
      await expect(ensureSeedWallet(node, options)).resolves.toEqual(
        `${symbol} node wallet "${wallet}" matches seed.dat (84h and 86h, 1h/${account}h)`,
      );

      const key = (path: string) => master.derive(path).publicKey!;
      const network = Networks.regtest;

      expect(
        await rpc(nodePort, 'getnewaddress', ['', 'bech32'], wallet),
      ).toEqual(p2wpkh(key(`m/84'/1'/${account}'/0/0`), network).address);
      expect(
        await rpc(nodePort, 'getnewaddress', ['', 'bech32m'], wallet),
      ).toEqual(
        p2tr(key(`m/86'/1'/${account}'/0/0`).subarray(1), undefined, network)
          .address,
      );
      expect(
        await rpc(nodePort, 'getrawchangeaddress', ['bech32'], wallet),
      ).toEqual(p2wpkh(key(`m/84'/1'/${account}'/1/0`), network).address);
      expect(
        await rpc(nodePort, 'getrawchangeaddress', ['bech32m'], wallet),
      ).toEqual(
        p2tr(key(`m/86'/1'/${account}'/1/0`).subarray(1), undefined, network)
          .address,
      );

      // The node computes the same checksums
      for (const d of seedWalletDescriptors(master, 1, account)) {
        const [body, checksum] = d.privateDescriptor.split('#');
        expect(
          (
            await rpc<{ checksum: string }>(
              nodePort,
              'getdescriptorinfo',
              [body],
              '',
            )
          ).checksum,
        ).toEqual(checksum);
        expect(checksum).toEqual(descriptorChecksum(body));
      }
    },
  );

  test.each(cases)(
    '$symbol: loads the wallet after an unload, with load_on_startup',
    async ({ symbol, nodePort, account }) => {
      const wallet = `seedtest_${symbol.toLowerCase()}_${stamp}`;
      await rpc(nodePort, 'unloadwallet', [wallet], '');

      await expect(
        ensureSeedWallet(nodeFor(symbol, nodePort, wallet), {
          wallet,
          account,
          network: 'regtest',
          master,
        }),
      ).resolves.toEqual(
        `${symbol} node wallet "${wallet}" loaded; matches seed.dat (84h and 86h, 1h/${account}h)`,
      );
    },
  );

  test.each(cases)(
    '$symbol: refuses a wallet made with other keys',
    async ({ symbol, nodePort, account }) => {
      const wallet = `seedtest_${symbol.toLowerCase()}_other_${stamp}`;
      toUnload.push([nodePort, wallet]);
      // An ordinary descriptor wallet with its own random keys
      await rpc(nodePort, 'createwallet', [wallet], '');

      await expect(
        ensureSeedWallet(nodeFor(symbol, nodePort, wallet), {
          wallet,
          account,
          network: 'regtest',
          master,
        }),
      ).rejects.toThrow(
        `${symbol} node wallet "${wallet}" does not match seed.dat`,
      );
    },
  );
});
