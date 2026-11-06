import { Transaction } from '@scure/btc-signer';
import { inputsWithoutOptIn } from '../../../lib/blake2b/WalletOptIn';

// A three-input Taproot key-path spend from the SHA256 regtest chain:
// 64-byte signatures, SIGHASH_DEFAULT, the form B5 recorded (Oct 29)
const TAPROOT_DEFAULT =
  '020000000001035fa5f26110db753e624b9a61b3139302356f3e5ebd71cd024d33e9c85a07279c0000000000fefffffffa8793cff93a06d4bcbdaff1b3407509a39b13615a77352bdf40930e972085c60000000000feffffff4da9729af7be8581883a5b1ea41b795d38f99c783dc061a549e7e51fb1d36e550000000000feffffff027e0a0300000000001976a914ead38539f2070c0faa99df6366434792452b518b88ac7b83010000000000225120fa20265bd8502042e5d22a2394903ccdece69bc7197c05e81c5519af42da6fcf0140b26cb92b7c205fc148265f81fa6f5174576adccfd99d6090db23f8009b0664f083c6b44be2fa35794d8d84184cc56301ea28fedfc742492ba5beb231eb05b9cd0140f46ce64bb0bd62fb59f91e4b033ca5a9c4fa3be05c6c2d91171ba0efce63b8679c3d576dbd28bf550418f4c770d4ca138b71a36ac43c9bdf6a513b10ebe1aeab0140b659c0ab7e5e1595b143b461ba337a11cad59c026384ec8bc641c18a42b98dad75ee6f377d66ee824cfcafcbad1122ba632c4b1fb77819a0759ee8b06e0164dc47050000';

// The same with each signature carrying 0x21 (65 bytes), the form the Knots
// BTC wallet signs on BLAKE2b (D23 update, Nov 5). "0140" (one 64-byte
// witness element) occurs only in the three witnesses.
const TAPROOT_UNIFIED = TAPROOT_DEFAULT.replace(
  /0140([0-9a-f]{128})/g,
  (_, sig: string) => `0141${sig}21`,
);

const G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

/** One P2PKH input signed with `hashType`, one P2WPKH output */
const p2pkhSpend = (hashType: string) =>
  [
    '01000000',
    '01',
    '11'.repeat(32),
    '00000000',
    '6a',
    '47',
    `3044${'00'.repeat(68)}${hashType}`,
    '21',
    G,
    'ffffffff',
    '01',
    'e803000000000000',
    '16',
    `0014${'22'.repeat(20)}`,
    '00000000',
  ].join('');

const parse = (hex: string) => Transaction.fromRaw(Buffer.from(hex, 'hex'));

describe('inputsWithoutOptIn (D38 S4)', () => {
  test('Taproot key path, 64-byte signatures: no input opts in', () => {
    expect(inputsWithoutOptIn(parse(TAPROOT_DEFAULT))).toEqual([0, 1, 2]);
  });

  test('Taproot key path, 65-byte 0x21 signatures: every input opts in', () => {
    expect(inputsWithoutOptIn(parse(TAPROOT_UNIFIED))).toEqual([]);
  });

  test('P2PKH signed ALL|UNIFIED opts in; ALL does not', () => {
    expect(inputsWithoutOptIn(parse(p2pkhSpend('21')))).toEqual([]);
    expect(inputsWithoutOptIn(parse(p2pkhSpend('01')))).toEqual([0]);
  });
});
