import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utils as btcUtils } from '@scure/btc-signer';

/**
 * D38: BIP158 basic block filters, to find the block of a transaction on a
 * pruned node without txindex. A block's filter holds every output script
 * the block creates and every script its inputs spend. Given the script an
 * output was locked to, the blocks whose filter matches are the only ones
 * that can hold the transaction that created it. The SHA-256 Companion runs
 * `blockfilterindex=basic` (V1, Nov 5), and the filters survive pruning.
 *
 * A match is only a candidate (false positives are 1 in 784,931 by design);
 * the caller then fetches the transaction from that block by hash and checks
 * its txid, so a wrong match costs one lookup and nothing else.
 */

const P = 19;
const M = 784_931n;
const MASK = (1n << 64n) - 1n;

const rotl = (x: bigint, b: bigint) => ((x << b) | (x >> (64n - b))) & MASK;

const readLE64 = (b: Uint8Array, i: number) => {
  let v = 0n;
  for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(b[i + k]);
  return v;
};

/** SipHash-2-4 with a 128-bit key given as two little-endian 64-bit halves */
export const siphash24 = (k0: bigint, k1: bigint, m: Uint8Array): bigint => {
  let v0 = 0x736f6d6570736575n ^ k0;
  let v1 = 0x646f72616e646f6dn ^ k1;
  let v2 = 0x6c7967656e657261n ^ k0;
  let v3 = 0x7465646279746573n ^ k1;
  const round = () => {
    v0 = (v0 + v1) & MASK;
    v1 = rotl(v1, 13n) ^ v0;
    v0 = rotl(v0, 32n);
    v2 = (v2 + v3) & MASK;
    v3 = rotl(v3, 16n) ^ v2;
    v0 = (v0 + v3) & MASK;
    v3 = rotl(v3, 21n) ^ v0;
    v2 = (v2 + v1) & MASK;
    v1 = rotl(v1, 17n) ^ v2;
    v2 = rotl(v2, 32n);
  };
  const tail = m.length % 8;
  const end = m.length - tail;
  for (let i = 0; i < end; i += 8) {
    const mi = readLE64(m, i);
    v3 ^= mi;
    round();
    round();
    v0 ^= mi;
  }
  let last = BigInt(m.length & 0xff) << 56n;
  for (let i = 0; i < tail; i++) last |= BigInt(m[end + i]) << BigInt(8 * i);
  v3 ^= last;
  round();
  round();
  v0 ^= last;
  v2 ^= 0xffn;
  round();
  round();
  round();
  round();
  return (v0 ^ v1 ^ v2 ^ v3) & MASK;
};

const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** The filter key: the block hash in internal byte order, first 16 bytes */
const filterKey = (blockHashHex: string): [bigint, bigint] => {
  const internal = fromHex(blockHashHex).reverse();
  return [readLE64(internal, 0), readLE64(internal, 8)];
};

const compactSize = (b: Uint8Array): [number, number] => {
  const n = b[0];
  if (n < 0xfd) return [n, 1];
  const view = new DataView(b.buffer, b.byteOffset + 1);
  if (n === 0xfd) return [view.getUint16(0, true), 3];
  if (n === 0xfe) return [view.getUint32(0, true), 5];
  return [Number(view.getBigUint64(0, true)), 9];
};

/** Hash an item into the filter's range [0, N * M) */
export const hashToRange = (
  key: [bigint, bigint],
  items: number,
  item: Uint8Array,
): number =>
  Number((siphash24(key[0], key[1], item) * (BigInt(items) * M)) >> 64n);

/**
 * True when any of `scripts` (hex) may be in the block's basic filter
 * (`getblockfilter <hash> basic`, field `filter`).
 */
export const filterMatchesAny = (
  filterHex: string,
  blockHashHex: string,
  scripts: string[],
): boolean => {
  if (scripts.length === 0) return false;
  const data = fromHex(filterHex);
  const [n, offset] = compactSize(data);
  if (n === 0) return false;
  const key = filterKey(blockHashHex);
  const targets = scripts
    .map((s) => hashToRange(key, n, fromHex(s)))
    .sort((a, b) => a - b);

  let bit = offset * 8;
  const readBit = () => {
    const v = (data[bit >> 3] >> (7 - (bit & 7))) & 1;
    bit++;
    return v;
  };

  let value = 0;
  let t = 0;
  for (let i = 0; i < n; i++) {
    let q = 0;
    while (readBit() === 1) q++;
    let r = 0;
    for (let k = 0; k < P; k++) r = r * 2 + readBit();
    value += q * 2 ** P + r;
    while (t < targets.length && targets[t] < value) t++;
    if (t === targets.length) return false;
    if (targets[t] === value) return true;
  }
  return false;
};

/* ---------- the script an input spent ---------- */

const hash160 = (b: Uint8Array) => ripemd160(sha256(b));

const tagged = (tag: string, ...parts: Uint8Array[]) => {
  const t = sha256(new TextEncoder().encode(tag));
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const msg = new Uint8Array(64 + total);
  msg.set(t, 0);
  msg.set(t, 32);
  let o = 64;
  for (const p of parts) {
    msg.set(p, o);
    o += p.length;
  }
  return sha256(msg);
};

const sizePrefix = (len: number) =>
  len < 0xfd
    ? Uint8Array.of(len)
    : Uint8Array.of(0xfd, len & 0xff, (len >> 8) & 0xff);

const lessThan = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
};

/** Output script of a Taproot script-path spend, from its script and control block */
const taprootScript = (script: Uint8Array, control: Uint8Array) => {
  let node = tagged(
    'TapLeaf',
    Uint8Array.of(control[0] & 0xfe),
    sizePrefix(script.length),
    script,
  );
  for (let o = 33; o < control.length; o += 32) {
    const sibling = control.subarray(o, o + 32);
    node = lessThan(node, sibling)
      ? tagged('TapBranch', node, sibling)
      : tagged('TapBranch', sibling, node);
  }
  const [outputKey] = btcUtils.taprootTweakPubkey(
    control.subarray(1, 33),
    node,
  );
  return `5120${toHex(outputKey)}`;
};

/** Data pushes of a scriptSig, in order */
const pushes = (scriptSigHex: string): Uint8Array[] => {
  const s = fromHex(scriptSigHex);
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < s.length) {
    const op = s[i++];
    let len = -1;
    if (op >= 1 && op <= 75) len = op;
    else if (op === 76) len = s[i++];
    else if (op === 77) {
      len = s[i] | (s[i + 1] << 8);
      i += 2;
    } else if (op === 78) {
      len = s[i] | (s[i + 1] << 8) | (s[i + 2] << 16) | (s[i + 3] << 24);
      i += 4;
    }
    if (len >= 0) {
      out.push(s.subarray(i, i + len));
      i += len;
    }
  }
  return out;
};

/**
 * The output scripts an input could have spent, worked out from its
 * scriptSig and witness. Empty for a Taproot key-path spend, which reveals
 * only a signature. More than one candidate where the spend is ambiguous
 * (each is checked; a wrong one only fails to match).
 */
export const spentScripts = (input: {
  scriptSig?: { hex?: string };
  txinwitness?: string[];
}): string[] => {
  let witness = (input.txinwitness ?? []).map(fromHex);
  // Drop a Taproot annex
  if (witness.length >= 2 && witness[witness.length - 1][0] === 0x50) {
    witness = witness.slice(0, -1);
  }
  const sig = pushes(input.scriptSig?.hex ?? '');
  const out = new Set<string>();

  if (sig.length > 0) {
    const last = sig[sig.length - 1];
    // P2SH (including P2SH-wrapped segwit): the last push is the redeem script
    out.add(`a914${toHex(hash160(last))}87`);
    if (witness.length === 0 && (last.length === 33 || last.length === 65)) {
      out.add(`76a914${toHex(hash160(last))}88ac`);
    }
    return [...out];
  }

  if (witness.length >= 2) {
    const last = witness[witness.length - 1];
    if (witness.length === 2 && last.length === 33) {
      out.add(`0014${toHex(hash160(last))}`);
    }
    out.add(`0020${toHex(sha256(last))}`);
    if (
      last.length >= 33 &&
      (last.length - 33) % 32 === 0 &&
      (last[0] & 0xfe) === 0xc0
    ) {
      try {
        out.add(taprootScript(witness[witness.length - 2], last));
      } catch {
        // Not a valid internal key: not a Taproot spend after all
      }
    }
  }
  return [...out];
};
