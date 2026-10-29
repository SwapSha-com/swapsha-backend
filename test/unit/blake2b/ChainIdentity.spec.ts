import {
  ChainIdentityError,
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
}) => {
  const client = Object.create(ChainClient.prototype) as ChainClient;
  Object.defineProperty(client, 'symbol', { value: 'XBT' });
  (client as any).rpc = jest.fn(async (method: string) => {
    if (method === 'getdeploymentinfo') {
      return opts.deployment === undefined
        ? { deployments: {} }
        : { deployments: { blake2b: opts.deployment } };
    }
    if (method === 'getblockheader') return opts.header;
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

  test('refuses BLAKE2b mainnet unless explicitly allowed', async () => {
    await expect(
      verifyChainIdentity(
        mockClient({ deployment: { height: 961640, active: true } }),
        true,
        'mainnet',
      ),
    ).rejects.toThrow('Mainnet stays off until Phase 5');
  });

  test('refuses a mainnet fork block that is not the known one', async () => {
    process.env.SWAPSHA_ALLOW_MAINNET = '1';
    await expect(
      verifyChainIdentity(
        mockClient({
          deployment: { height: 961640, active: true },
          header: V2_HEADER,
          hash: V2_HASH,
        }),
        true,
        'mainnet',
      ),
    ).rejects.toThrow('not the BLAKE2b mainnet fork block');
  });
});
