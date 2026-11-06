import { secp256k1 } from '@noble/curves/secp256k1.js';
import { TaprootControlBlock, p2tr } from '@scure/btc-signer';
import {
  filterMatchesAny,
  hashToRange,
  siphash24,
  spentScripts,
} from '../../../lib/blake2b/BlockFilter';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

const readLE64 = (b: Uint8Array, i: number) => {
  let v = 0n;
  for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(b[i + k]);
  return v;
};

/** BIP158 encoder, written independently here, to check the decoder */
const encodeFilter = (blockHash: string, items: string[]) => {
  const internal = bytes(blockHash).reverse();
  const key: [bigint, bigint] = [readLE64(internal, 0), readLE64(internal, 8)];
  const values = [
    ...new Set(items.map((i) => hashToRange(key, items.length, bytes(i)))),
  ].sort((a, b) => a - b);
  const bits: number[] = [];
  let last = 0;
  for (const v of values) {
    const delta = v - last;
    last = v;
    const q = Math.floor(delta / 2 ** 19);
    const r = delta % 2 ** 19;
    for (let i = 0; i < q; i++) bits.push(1);
    bits.push(0);
    for (let k = 18; k >= 0; k--) bits.push(Math.floor(r / 2 ** k) % 2);
  }
  const out = new Uint8Array(1 + Math.ceil(bits.length / 8));
  out[0] = values.length;
  bits.forEach((b, i) => {
    if (b) out[1 + (i >> 3)] |= 0x80 >> (i & 7);
  });
  return hex(out);
};

describe('BlockFilter (D38)', () => {
  test('SipHash-2-4 matches the reference vector', () => {
    // Key 00..0f, message 00..0e (the SipHash paper, Appendix A)
    const key = bytes('000102030405060708090a0b0c0d0e0f');
    const message = bytes('000102030405060708090a0b0c0d0e');
    expect(
      siphash24(readLE64(key, 0), readLE64(key, 8), message).toString(16),
    ).toEqual('a129ca6149be45e5');
  });

  describe('filterMatchesAny', () => {
    const block =
      '000000000000000000025b8b6b1a10b8f5a31b8fd4a5c1a0f2a7bd1c9a1e8f00';
    const scripts = Array.from(
      { length: 40 },
      (_, i) => `0014${i.toString(16).padStart(40, '0')}`,
    );
    const filter = encodeFilter(block, scripts);

    test('finds every script the block holds', () => {
      for (const s of scripts) {
        expect(filterMatchesAny(filter, block, [s])).toBe(true);
      }
    });

    test('rejects scripts it does not hold', () => {
      expect(filterMatchesAny(filter, block, [`0014${'ab'.repeat(20)}`])).toBe(
        false,
      );
      expect(filterMatchesAny(filter, block, [`5120${'cd'.repeat(32)}`])).toBe(
        false,
      );
    });

    test('one matching script among several is a match', () => {
      expect(
        filterMatchesAny(filter, block, [`0014${'ab'.repeat(20)}`, scripts[7]]),
      ).toBe(true);
    });

    test('the key is the block hash: another block does not match', () => {
      const other = `${block.slice(0, -2)}01`;
      const hits = scripts.filter((s) => filterMatchesAny(filter, other, [s]));
      expect(hits.length).toBeLessThan(2);
    });

    test('an empty filter matches nothing', () => {
      expect(filterMatchesAny('00', block, [scripts[0]])).toBe(false);
    });
  });

  describe('spentScripts', () => {
    // The generator point; hash160 is the BIP173 example program
    const G =
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

    test('P2WPKH from the public key in the witness', () => {
      expect(
        spentScripts({ txinwitness: [`30${'00'.repeat(70)}01`, G] }),
      ).toContain('0014751e76e8199196d454941c45d1b3a323f1433bd6');
    });

    test('P2PKH and P2SH from a legacy scriptSig', () => {
      const scriptSig = `47${'00'.repeat(71)}21${G}`;
      const out = spentScripts({ scriptSig: { hex: scriptSig } });
      expect(out).toContain(
        '76a914751e76e8199196d454941c45d1b3a323f1433bd688ac',
      );
      expect(out.some((s) => s.startsWith('a914'))).toBe(true);
    });

    test('a Taproot script-path spend gives the output key', () => {
      const internal = secp256k1
        .getPublicKey(secp256k1.utils.randomSecretKey(), true)
        .subarray(1);
      const leaf = bytes('51');
      const pay = p2tr(internal, { script: leaf }, undefined, true);
      const [cb, scriptWithVersion] = pay.tapLeafScript![0];
      const witness = [
        'ab'.repeat(64),
        hex(scriptWithVersion.subarray(0, -1)),
        hex(TaprootControlBlock.encode(cb)),
      ];
      expect(spentScripts({ txinwitness: witness })).toContain(hex(pay.script));
    });

    test('a Taproot key-path spend reveals no script', () => {
      expect(spentScripts({ txinwitness: ['ab'.repeat(64)] })).toEqual([]);
    });
  });
});
