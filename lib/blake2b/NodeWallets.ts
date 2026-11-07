import type { HDKey } from '@scure/bip32';
import type ChainClient from '../chain/ChainClient';
import { networkKind } from './ChainIdentity';

/**
 * Blueprint D39 and D40 (amended Nov 6, option C): SwapSha's provider wallet
 * on each Knots node is derived from seed.dat. Standard BIP84 and BIP86
 * accounts, one per chain (BTC on the BLAKE2b node 0', the SHA-256 wallet 1'),
 * coin type 0' on mainnet and 1' on test networks, receive 0 and change 1,
 * kept apart from the swap keys' m/0/<currency>/<index> tree.
 *
 * At startup the backend creates the wallet blank with load_on_startup and
 * imports the four descriptors (timestamp now, no rescan), loads it if it
 * exists but is not loaded, and refuses to start if it holds anything else,
 * so the funds stay recoverable from seed.dat alone.
 */

type SeedWalletNode = Pick<ChainClient, 'symbol' | 'rpc' | 'walletRpc'>;

type ListedDescriptor = {
  desc: string;
  active: boolean;
  internal?: boolean;
};

type ImportResult = {
  success: boolean;
  error?: { code?: number; message?: string };
};

type SeedDescriptor = {
  /** wpkh or tr */
  type: 'wpkh' | 'tr';
  /** 0 receive, 1 change */
  branch: 0 | 1;
  /** With the private key and checksum, for importdescriptors */
  privateDescriptor: string;
  /** The account xpub (tpub on test networks), to recognize the node's copy */
  accountXpub: string;
};

const purposes = [
  { type: 'wpkh', purpose: 84 },
  { type: 'tr', purpose: 86 },
] as const;

// BIP380 descriptor checksum
const INPUT_CHARSET =
  '0123456789()[],\'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#"\\ ';
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [
  0xf5dee51989n,
  0xa9fdca3312n,
  0x1bab10e32dn,
  0x3706b1677an,
  0x644d626ffdn,
];

const polymod = (symbols: number[]): bigint => {
  let chk = 1n;
  for (const value of symbols) {
    const top = chk >> 35n;
    chk = ((chk & 0x7ffffffffn) << 5n) ^ BigInt(value);
    for (let i = 0; i < 5; i++) {
      if ((top >> BigInt(i)) & 1n) {
        chk ^= GENERATOR[i];
      }
    }
  }
  return chk;
};

/** The 8-character BIP380 checksum of a descriptor without one */
export const descriptorChecksum = (descriptor: string): string => {
  const symbols: number[] = [];
  let groups: number[] = [];
  for (const c of descriptor) {
    const v = INPUT_CHARSET.indexOf(c);
    if (v === -1) {
      throw new Error(`invalid descriptor character: ${JSON.stringify(c)}`);
    }
    symbols.push(v & 31);
    groups.push(v >> 5);
    if (groups.length === 3) {
      symbols.push(groups[0] * 9 + groups[1] * 3 + groups[2]);
      groups = [];
    }
  }
  if (groups.length === 1) {
    symbols.push(groups[0]);
  } else if (groups.length === 2) {
    symbols.push(groups[0] * 3 + groups[1]);
  }

  const checksum = polymod([...symbols, 0, 0, 0, 0, 0, 0, 0, 0]) ^ 1n;
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += CHECKSUM_CHARSET[Number((checksum >> BigInt(5 * (7 - i))) & 31n)];
  }
  return out;
};

/** Keeps extended private keys out of error messages and logs */
export const redactKeys = (text: string): string =>
  text.replace(/[xt]prv[1-9A-HJ-NP-Za-km-z]{50,}/g, '<private key>');

/** BIP32 versions the node accepts: xprv/xpub on mainnet, tprv/tpub on test networks */
export const bip32VersionsFor = (
  network: string,
): { private: number; public: number } =>
  networkKind(network) === 'mainnet'
    ? { private: 0x0488ade4, public: 0x0488b21e }
    : { private: 0x04358394, public: 0x043587cf };

/** 0' on mainnet, 1' on every test network (D40) */
export const coinTypeFor = (network: string): 0 | 1 =>
  networkKind(network) === 'mainnet' ? 0 : 1;

/**
 * The four descriptors of a seed wallet account. `master` must carry the
 * network's BIP32 versions (xprv on mainnet, tprv on test networks), as the
 * node only accepts its own network's.
 */
export const seedWalletDescriptors = (
  master: HDKey,
  coinType: 0 | 1,
  account: number,
): SeedDescriptor[] => {
  if (!Number.isInteger(account) || account < 0 || account >= 2 ** 31) {
    throw new Error(`invalid seed wallet account: ${account}`);
  }

  const fingerprint = master.fingerprint.toString(16).padStart(8, '0');

  return purposes.flatMap(({ type, purpose }) => {
    const node = master.derive(`m/${purpose}'/${coinType}'/${account}'`);
    const origin = `[${fingerprint}/${purpose}h/${coinType}h/${account}h]`;

    return ([0, 1] as const).map((branch) => {
      const body = `${type}(${origin}${node.privateExtendedKey}/${branch}/*)`;
      return {
        type,
        branch,
        privateDescriptor: `${body}#${descriptorChecksum(body)}`,
        accountXpub: node.publicExtendedKey,
      };
    });
  });
};

const isOurs = (listed: ListedDescriptor, expected: SeedDescriptor) =>
  listed.desc.startsWith(`${expected.type}(`) &&
  listed.desc.includes(`${expected.accountXpub}/${expected.branch}/*)`);

/**
 * Creates, loads or checks the node wallet `wallet`. Returns a line for the
 * log; throws, and so stops startup, when the wallet holds other keys.
 */
export const ensureSeedWallet = async (
  node: SeedWalletNode,
  options: {
    wallet: string | undefined;
    account: number;
    network: string;
    master: HDKey;
  },
): Promise<string> => {
  const { wallet, account, network, master } = options;
  const name = `${node.symbol} node wallet "${wallet}"`;

  if (wallet === undefined || wallet === '') {
    throw new Error(
      `${node.symbol}: seedAccount needs a wallet name in [currencies.chain] (D40)`,
    );
  }

  const coinType = coinTypeFor(network);
  const expected = seedWalletDescriptors(master, coinType, account);
  const path = `84h and 86h, ${coinType}h/${account}h`;
  const done: string[] = [];

  const loaded = await node.rpc<string[]>('listwallets');
  if (!loaded.includes(wallet)) {
    const { wallets } = await node.rpc<{ wallets: { name: string }[] }>(
      'listwalletdir',
    );
    if (wallets.some((w) => w.name === wallet)) {
      // load_on_startup, so a restored node scans for it while it resyncs
      await node.rpc('loadwallet', [wallet, true]);
      done.push('loaded');
    } else {
      // name, disable_private_keys, blank, passphrase, avoid_reuse,
      // descriptors, load_on_startup
      await node.rpc('createwallet', [
        wallet,
        false,
        true,
        '',
        false,
        true,
        true,
      ]);
      done.push('created');
    }
  }

  const listDescriptors = async () =>
    (
      await node.walletRpc<{ descriptors: ListedDescriptor[] }>(
        'listdescriptors',
        [false],
      )
    ).descriptors;

  let listed = await listDescriptors();

  // A blank wallet: just created, or a creation that stopped before importing
  if (listed.length === 0) {
    let results: ImportResult[];
    try {
      results = await node.walletRpc<ImportResult[]>('importdescriptors', [
        expected.map((d) => ({
          desc: d.privateDescriptor,
          active: true,
          internal: d.branch === 1,
          timestamp: 'now',
        })),
      ]);
    } catch (error) {
      throw new Error(
        redactKeys(
          `${name}: importing the seed descriptors failed: ${(error as Error).message ?? String(error)}`,
        ),
      );
    }

    const failed = results.filter((r) => !r.success);
    if (failed.length > 0 || results.length !== expected.length) {
      throw new Error(
        redactKeys(
          `${name}: importing the seed descriptors failed: ${failed
            .map((r) => r.error?.message ?? 'unknown error')
            .join('; ')}`,
        ),
      );
    }

    done.push('filled from seed.dat');
    listed = await listDescriptors();
  }

  const missing = expected.filter(
    (e) =>
      !listed.some(
        (l) =>
          isOurs(l, e) &&
          l.active &&
          (l.internal === true) === (e.branch === 1),
      ),
  );
  const foreign = listed.filter((l) => !expected.some((e) => isOurs(l, e)));

  if (missing.length > 0 || foreign.length > 0) {
    throw new Error(
      `${name} does not match seed.dat (D40, ${path}): ` +
        [
          missing.length > 0
            ? `${missing.length} of SwapSha's 4 descriptors missing or not active`
            : undefined,
          foreign.length > 0
            ? `${foreign.length} other descriptor(s) present`
            : undefined,
        ]
          .filter((part) => part !== undefined)
          .join(', ') +
        '. SwapSha will not use a wallet it cannot recover from its seed. Unload and rename that wallet on the node, or point SwapSha at another wallet name',
    );
  }

  return `${name} ${done.length > 0 ? `${done.join(', ')}; ` : ''}matches seed.dat (${path})`;
};
