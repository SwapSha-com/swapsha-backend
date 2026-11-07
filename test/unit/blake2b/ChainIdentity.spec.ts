import {
  ChainIdentityError,
  networkKind,
  verifyChainIdentity,
} from '../../../lib/blake2b/ChainIdentity';
import ChainClient from '../../../lib/chain/ChainClient';

// A real v2 header and its BLAKE2b hash, from Knots
// src/test/data/block_header_v2.json ("profile_0_time_offset").
const V2_HEADER =
  '000000a01f1e1d1c1b1a191817161514131211100f0e0d0c0b0a0908070605040302010000112233445566778899aabbccddeeff00102030405060708090a0b0c0d0e0f0a8913577ffff001d0df0ad0b44332211efcdab89ffeeddccbbaa998877665544332211005802000003001c000000000000000000000000000000000040d10c008967452301efcdab8967452301efcdab8967452301efcdab8967452301efcdab';
const V2_HASH =
  '4b495dcf05d70a49785b799b22284fbcd9dd1209237c53c87e4674b15587d704';
// Bitcoin genesis: a v1 header.
const V1_HEADER =
  '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
const V1_HASH =
  '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

const mockClient = (opts: {
  deployment?: { height: number; active: boolean };
  header?: string;
  hash?: string;
  chain?: string;
}) => {
  const client = Object.create(ChainClient.prototype) as ChainClient;
  Object.defineProperty(client, 'symbol', { value: 'XBT' });
  (client as any).rpc = jest.fn(async (method: string) => {
    if (method === 'getdeploymentinfo') {
      // Shaped like Knots 29.4.1: blake2b sits beside deployments
      return opts.deployment === undefined
        ? { deployments: { taproot: { active: true } } }
        : {
            deployments: { taproot: { active: true } },
            blake2b: opts.deployment,
          };
    }
    if (method === 'getblockheader') return opts.header;
    if (method === 'getblockchaininfo') {
      return { chain: opts.chain ?? 'regtest' };
    }
    throw new Error(method);
  });
  (client as any).getBlockhash = jest.fn(async () => opts.hash);
  return client;
};

describe('verifyChainIdentity', () => {
  afterEach(() => {
    delete process.env.SWAPSHA_ALLOW_MAINNET;
  });

  test('accepts a SHA-256 node for a SHA-256 currency', async () => {
    await expect(
      verifyChainIdentity(mockClient({}), false, 'regtest'),
    ).resolves.toContain('SHA-256 chain');
  });

  test('refuses a BLAKE2b node for a SHA-256 currency', async () => {
    await expect(
      verifyChainIdentity(
        mockClient({ deployment: { height: 200, active: true } }),
        false,
        'regtest',
      ),
    ).rejects.toThrow(ChainIdentityError);
  });

  test('refuses a SHA-256 node for a BLAKE2b currency', async () => {
    await expect(
      verifyChainIdentity(mockClient({}), true, 'regtest'),
    ).rejects.toThrow('no active BLAKE2b deployment');
  });

  test('refuses a scheduled but not yet active deployment', async () => {
    await expect(
      verifyChainIdentity(
        mockClient({ deployment: { height: 200, active: false } }),
        true,
        'regtest',
      ),
    ).rejects.toThrow('no active BLAKE2b deployment');
  });

  test('accepts a BLAKE2b node whose fork block has a valid v2 header', async () => {
    await expect(
      verifyChainIdentity(
        mockClient({
          deployment: { height: 200, active: true },
          header: V2_HEADER,
          hash: V2_HASH,
        }),
        true,
        'regtest',
      ),
    ).resolves.toContain(`fork block 200 ${V2_HASH}`);
  });

  test('refuses when the fork block header is v1', async () => {
    await expect(
      verifyChainIdentity(
        mockClient({
          deployment: { height: 200, active: true },
          header: V1_HEADER,
          hash: V1_HASH,
        }),
        true,
        'regtest',
      ),
    ).rejects.toThrow('not a valid v2 BLAKE2b header');
  });

  test('refuses when the header does not hash to the reported block hash', async () => {
    await expect(
      verifyChainIdentity(
        mockClient({
          deployment: { height: 200, active: true },
          header: V2_HEADER,
          hash: V1_HASH,
        }),
        true,
        'regtest',
      ),
    ).rejects.toThrow('not a valid v2 BLAKE2b header');
  });

  // D37 (amended Nov 6): mainnet runs every check; MainnetLock turns swaps down
  test('runs the mainnet fork block check without the allow flag', async () => {
    await expect(
      verifyChainIdentity(
        mockClient({
          deployment: { height: 961640, active: true },
          header: V2_HEADER,
          hash: V2_HASH,
          chain: 'main',
        }),
        true,
        'mainnet',
      ),
    ).rejects.toThrow('not the BLAKE2b mainnet fork block');
  });

  test('refuses a mainnet fork block that is not the known one', async () => {
    process.env.SWAPSHA_ALLOW_MAINNET = '1';
    await expect(
      verifyChainIdentity(
        mockClient({
          deployment: { height: 961640, active: true },
          header: V2_HEADER,
          hash: V2_HASH,
          chain: 'main',
        }),
        true,
        'mainnet',
      ),
    ).rejects.toThrow('not the BLAKE2b mainnet fork block');
  });

  test.each([
    ['mainnet', 'mainnet'],
    ['bitcoinMainnet', 'mainnet'],
    ['bitcoin', 'mainnet'],
    ['bitcoinTestnet', 'testnet'],
    ['testnet', 'testnet'],
    ['bitcoinRegtest', 'regtest'],
  ])('network name %s is %s', (name, kind) => {
    expect(networkKind(name)).toBe(kind);
  });

  test('fails closed on an unknown network name', () => {
    expect(() => networkKind('bitcoinMoon')).toThrow(ChainIdentityError);
  });

  test('the mainnet checks hold for the boltz-core spelling too', async () => {
    await expect(
      verifyChainIdentity(
        mockClient({
          deployment: { height: 961640, active: true },
          header: V2_HEADER,
          hash: V2_HASH,
          chain: 'main',
        }),
        true,
        'bitcoinMainnet',
      ),
    ).rejects.toThrow('not the BLAKE2b mainnet fork block');
  });

  test('refuses a mainnet BLAKE2b currency whose node is on testnet4', async () => {
    await expect(
      verifyChainIdentity(
        mockClient({
          deployment: { height: 150308, active: true },
          chain: 'testnet4',
        }),
        true,
        'mainnet',
      ),
    ).rejects.toThrow('configured for mainnet but its node is on "testnet4"');
  });

  test('refuses a node on a different network than configured', async () => {
    await expect(
      verifyChainIdentity(
        mockClient({ chain: 'testnet4' }),
        false,
        'bitcoinRegtest',
      ),
    ).rejects.toThrow(
      'configured for bitcoinRegtest but its node is on "testnet4"',
    );
  });

  test('accepts the testnet4 BLAKE2b fork at 150,308', async () => {
    await expect(
      verifyChainIdentity(
        mockClient({
          deployment: { height: 150308, active: true },
          header: V2_HEADER,
          hash: V2_HASH,
          chain: 'testnet4',
        }),
        true,
        'bitcoinTestnet',
      ),
    ).resolves.toContain('fork block 150308');
  });

  test('refuses a testnet BLAKE2b fork at any other height', async () => {
    await expect(
      verifyChainIdentity(
        mockClient({
          deployment: { height: 200, active: true },
          header: V2_HEADER,
          hash: V2_HASH,
          chain: 'testnet4',
        }),
        true,
        'bitcoinTestnet',
      ),
    ).rejects.toThrow('expected testnet4 at 150308');
  });
});
