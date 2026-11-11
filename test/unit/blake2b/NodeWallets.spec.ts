import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { p2tr, p2wpkh } from '@scure/btc-signer';
import {
  bip32VersionsFor,
  coinTypeFor,
  descriptorChecksum,
  directSeedWalletNode,
  ensureSeedWallet,
  redactKeys,
  seedWalletDescriptors,
} from '../../../lib/blake2b/NodeWallets';

const mockRequest = jest.fn().mockResolvedValue('ok');
const mockRpcClient = jest.fn().mockImplementation(() => ({
  request: mockRequest,
}));
jest.mock('../../../lib/chain/RpcClient', () => ({
  __esModule: true,
  default: function (...args: unknown[]) {
    return mockRpcClient(...args);
  },
}));

// BIP84 and BIP86 test vectors use this mnemonic (master fingerprint 73c5da0a)
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const master = (network: string) =>
  HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC), bip32VersionsFor(network));

type Listed = { desc: string; active: boolean; internal?: boolean };

/** A Knots node with wallets, enough for ensureSeedWallet */
const fakeNode = (state: {
  loaded?: string[];
  onDisk?: string[];
  descriptors?: Listed[];
  importFails?: string;
}) => {
  const loaded = state.loaded ?? [];
  const onDisk = state.onDisk ?? [...loaded];
  let descriptors = state.descriptors ?? [];
  const calls: { method: string; params?: unknown[] }[] = [];

  const node = {
    symbol: 'BTC',
    rpc: jest.fn(async (method: string, params?: unknown[]) => {
      calls.push({ method, params });
      switch (method) {
        case 'listwallets':
          return loaded;
        case 'listwalletdir':
          return { wallets: onDisk.map((name) => ({ name })) };
        case 'loadwallet':
          loaded.push(params![0] as string);
          return {};
        case 'createwallet':
          onDisk.push(params![0] as string);
          loaded.push(params![0] as string);
          return {};
      }
      throw new Error(method);
    }),
    walletRpc: jest.fn(async (method: string, params?: unknown[]) => {
      calls.push({ method, params });
      if (method === 'listdescriptors') {
        return { descriptors };
      }
      if (method === 'importdescriptors') {
        const requests = params![0] as {
          desc: string;
          active: boolean;
          internal: boolean;
        }[];
        if (state.importFails !== undefined) {
          return requests.map(() => ({
            success: false,
            error: { message: state.importFails },
          }));
        }
        // The node lists the public form: xpub (tpub) instead of xprv
        descriptors = requests.map((r) => ({
          desc: r.desc
            .replace(/#.*$/, '')
            .replace(
              /[xt]prv\w+/,
              (key) =>
                HDKey.fromExtendedKey(key, bip32VersionsFor('regtest'))
                  .publicExtendedKey,
            ),
          active: r.active,
          internal: r.internal,
        }));
        return requests.map(() => ({ success: true }));
      }
      throw new Error(method);
    }),
  };

  return { node: node as any, calls };
};

const publicListing = (network: string, account: number): Listed[] =>
  seedWalletDescriptors(master(network), coinTypeFor(network), account).map(
    (d) => ({
      desc: `${d.type}([73c5da0a/${d.type === 'wpkh' ? 84 : 86}h/${coinTypeFor(network)}h/${account}h]${d.accountXpub}/${d.branch}/*)#abcdefgh`,
      active: true,
      internal: d.branch === 1,
    }),
  );

describe('NodeWallets (D40)', () => {
  test('descriptor checksum matches the BIP380 vector', () => {
    expect(descriptorChecksum('raw(deadbeef)')).toEqual('89f8spxm');
  });

  test('accounts match the BIP84 and BIP86 test vectors', () => {
    const descriptors = seedWalletDescriptors(master('mainnet'), 0, 0);
    const tr = descriptors.find((d) => d.type === 'tr')!;
    expect(tr.accountXpub).toEqual(
      'xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ',
    );
    expect(tr.privateDescriptor).toMatch(
      /^tr\(\[73c5da0a\/86h\/0h\/0h\]xprv9xgqHN7yz9MwCkxsBPN5qetuNdQSUttZNKw1dcYTV4mkaAFiBVGQziHs3NRSWMkCzvgjEe3n9xV8oYywvM8at9yRqyaZVz6TYYhX98VjsUk\/0\/\*\)#[a-z0-9]{8}$/,
    );

    // BIP84's zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs, as an xpub
    const wpkh = descriptors.find((d) => d.type === 'wpkh')!;
    expect(wpkh.accountXpub).toEqual(
      'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V',
    );

    // First receive addresses from BIP84 and BIP86
    const first = (xpub: string) =>
      HDKey.fromExtendedKey(xpub).deriveChild(0).deriveChild(0).publicKey!;
    expect(p2wpkh(first(wpkh.accountXpub)).address).toEqual(
      'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    );
    expect(p2tr(first(tr.accountXpub).subarray(1)).address).toEqual(
      'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
    );
  });

  test('four descriptors: wpkh and tr, receive and change, with checksums', () => {
    const descriptors = seedWalletDescriptors(master('regtest'), 1, 1);
    expect(descriptors.map((d) => `${d.type}/${d.branch}`)).toEqual([
      'wpkh/0',
      'wpkh/1',
      'tr/0',
      'tr/1',
    ]);
    for (const d of descriptors) {
      const [body, checksum] = d.privateDescriptor.split('#');
      expect(descriptorChecksum(body)).toEqual(checksum);
      expect(body).toContain(
        `[73c5da0a/${d.type === 'wpkh' ? 84 : 86}h/1h/1h]tprv`,
      );
      expect(d.accountXpub.startsWith('tpub')).toBe(true);
    }
  });

  test.each([
    ['mainnet', 0],
    ['bitcoinMainnet', 0],
    ['testnet', 1],
    ['bitcoinTestnet', 1],
    ['regtest', 1],
  ])('coin type on %s is %d', (network, coinType) => {
    expect(coinTypeFor(network)).toEqual(coinType);
  });

  test('refuses an account outside BIP32 hardened range', () => {
    expect(() => seedWalletDescriptors(master('regtest'), 1, -1)).toThrow(
      'invalid seed wallet account',
    );
    expect(() => seedWalletDescriptors(master('regtest'), 1, 2 ** 31)).toThrow(
      'invalid seed wallet account',
    );
  });

  test('creates a missing wallet blank with load_on_startup and fills it', async () => {
    const { node, calls } = fakeNode({});
    await expect(
      ensureSeedWallet(node, {
        wallet: 'swapsha',
        account: 0,
        network: 'regtest',
        master: master('regtest'),
      }),
    ).resolves.toEqual(
      'BTC node wallet "swapsha" created, filled from seed.dat; matches seed.dat (84h and 86h, 1h/0h). If a wallet of this name held coins before, run Recover Node Wallets (D40)',
    );

    expect(calls.find((c) => c.method === 'createwallet')!.params).toEqual([
      'swapsha',
      false,
      true,
      '',
      false,
      true,
      true,
    ]);
    const imported = calls.find((c) => c.method === 'importdescriptors')!
      .params![0] as any[];
    expect(imported).toHaveLength(4);
    for (const request of imported) {
      expect(request.timestamp).toEqual('now');
      expect(request.active).toBe(true);
      expect(request.internal).toEqual(/\/1\/\*\)#/.test(request.desc));
    }
  });

  test('loads a wallet that exists but is not loaded, with load_on_startup', async () => {
    const { node, calls } = fakeNode({
      onDisk: ['swapsha'],
      descriptors: publicListing('regtest', 0),
    });
    await expect(
      ensureSeedWallet(node, {
        wallet: 'swapsha',
        account: 0,
        network: 'regtest',
        master: master('regtest'),
      }),
    ).resolves.toEqual(
      'BTC node wallet "swapsha" loaded; matches seed.dat (84h and 86h, 1h/0h)',
    );
    expect(calls.find((c) => c.method === 'loadwallet')!.params).toEqual([
      'swapsha',
      true,
    ]);
    expect(calls.some((c) => c.method === 'importdescriptors')).toBe(false);
  });

  test('only checks a loaded wallet that matches', async () => {
    const { node, calls } = fakeNode({
      loaded: ['swapsha'],
      descriptors: publicListing('regtest', 1),
    });
    await expect(
      ensureSeedWallet(node, {
        wallet: 'swapsha',
        account: 1,
        network: 'regtest',
        master: master('regtest'),
      }),
    ).resolves.toEqual(
      'BTC node wallet "swapsha" matches seed.dat (84h and 86h, 1h/1h)',
    );
    expect(calls.map((c) => c.method)).toEqual([
      'listwallets',
      'listdescriptors',
    ]);
  });

  test('fills a blank wallet left by an interrupted creation', async () => {
    const { node, calls } = fakeNode({ loaded: ['swapsha'] });
    await expect(
      ensureSeedWallet(node, {
        wallet: 'swapsha',
        account: 0,
        network: 'regtest',
        master: master('regtest'),
      }),
    ).resolves.toContain('filled from seed.dat');
    expect(calls.some((c) => c.method === 'createwallet')).toBe(false);
  });

  test('refuses a wallet with other keys', async () => {
    const { node } = fakeNode({
      loaded: ['swapsha'],
      descriptors: [
        ...publicListing('regtest', 0),
        {
          desc: 'pkh([deadbeef/44h/1h/0h]tpubD6NzVbkrYhZ4WaWSyoBvQwbpLkojyoTZPRsgXELWz3Popb3qkjcJyJUGLnL4qHHoQvao8ESaAstxYSnhyswJ76uZPStJRJCTKvosUCJZL5B/0/*)#abcdefgh',
          active: false,
        },
      ],
    });
    await expect(
      ensureSeedWallet(node, {
        wallet: 'swapsha',
        account: 0,
        network: 'regtest',
        master: master('regtest'),
      }),
    ).rejects.toThrow(
      'BTC node wallet "swapsha" does not match seed.dat (D40, 84h and 86h, 1h/0h): 1 other descriptor(s) present',
    );
  });

  test('refuses a wallet from another account or seed', async () => {
    const { node } = fakeNode({
      loaded: ['swapsha'],
      descriptors: publicListing('regtest', 1),
    });
    await expect(
      ensureSeedWallet(node, {
        wallet: 'swapsha',
        account: 0,
        network: 'regtest',
        master: master('regtest'),
      }),
    ).rejects.toThrow(
      "4 of SwapSha's 4 descriptors missing or not active, 4 other descriptor(s) present",
    );
  });

  test('refuses when one of its descriptors is no longer active', async () => {
    const listing = publicListing('regtest', 0);
    listing[3].active = false;
    const { node } = fakeNode({ loaded: ['swapsha'], descriptors: listing });
    await expect(
      ensureSeedWallet(node, {
        wallet: 'swapsha',
        account: 0,
        network: 'regtest',
        master: master('regtest'),
      }),
    ).rejects.toThrow("1 of SwapSha's 4 descriptors missing or not active");
  });

  test('keeps private keys out of a failed import message', async () => {
    const key = master('regtest').derive("m/84'/1'/0'").privateExtendedKey;
    const { node } = fakeNode({ importFails: `key '${key}' is not valid` });
    const error = await ensureSeedWallet(node, {
      wallet: 'swapsha',
      account: 0,
      network: 'regtest',
      master: master('regtest'),
    }).catch((e: Error) => e);
    expect((error as Error).message).toContain(
      "key '<private key>' is not valid",
    );
    expect((error as Error).message).not.toContain('tprv');
  });

  test('redactKeys covers xprv and tprv', () => {
    const xprv = master('mainnet').privateExtendedKey;
    const tprv = master('regtest').privateExtendedKey;
    expect(redactKeys(`a ${xprv} b ${tprv} c`)).toEqual(
      'a <private key> b <private key> c',
    );
  });

  test('a direct connection goes to seedWalletRpc with the chain login', async () => {
    const logger = {} as any;
    const node = directSeedWalletNode(logger, 'SHA256', {
      host: '10.0.3.1',
      port: 18432,
      user: 'swapsha_test',
      password: 'secret',
      wallet: 'swapsha',
      seedWalletRpc: { host: '10.0.3.1', port: 18435 },
    });

    expect(mockRpcClient).toHaveBeenCalledWith(
      logger,
      'SHA256',
      expect.objectContaining({
        host: '10.0.3.1',
        port: 18435,
        user: 'swapsha_test',
        password: 'secret',
        wallet: 'swapsha',
      }),
    );

    await node.rpc('listwallets');
    await node.walletRpc('listdescriptors', [false]);
    expect(mockRequest).toHaveBeenNthCalledWith(1, 'listwallets', undefined);
    expect(mockRequest).toHaveBeenNthCalledWith(
      2,
      'listdescriptors',
      [false],
      true,
    );
  });

  test('needs a wallet name', async () => {
    const { node } = fakeNode({});
    await expect(
      ensureSeedWallet(node, {
        wallet: undefined,
        account: 0,
        network: 'regtest',
        master: master('regtest'),
      }),
    ).rejects.toThrow('seedAccount needs a wallet name');
  });
});
