import { Transaction } from '@scure/btc-signer';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  RescueRecord,
  RescuedLockup,
} from '../../../lib/blake2b/RescueRecords';
import {
  checkRescueSpend,
  readRescueRecords,
  rescuedFileName,
} from '../../../lib/blake2b/RescueRecords';

// The swap tree of type 2 swap 39A4obuRRMXN from the testnet4 rescue test
// (Nov 10): SwapSha's SHA-256 lockup, refund leaf with timeout 160433
const claimLeaf =
  '82012088a914be225b97edc03581280adf6dde85303cbbf5101f88203318702e21d8508be20d317e8aaee288363173ed8bce20088c269c35a73af2deac';
const refundLeaf =
  '20b80fcce5c864400d5be452ed3350f02204254c01a9aa407df6d392bbbe22aedcad03b17202b1';
const swapTree = JSON.stringify({
  claimLeaf: { version: 192, output: claimLeaf },
  refundLeaf: { version: 192, output: refundLeaf },
});

const preimage = randomBytes(32);
const lockup: RescuedLockup = {
  symbol: 'SHA256',
  transactionId:
    'bb8a6a2e6f42b237734eacc183db71c8e5b4a52f357d6401fe58e5217c22ede8',
  vout: 1,
  amount: 99_346,
  swapTree,
  preimageHash: createHash('sha256').update(preimage).digest('hex'),
};

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));

const spend = (witness: Uint8Array[], vout = lockup.vout, paid = 99_000n) => {
  const tx = new Transaction({
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
    disableScriptCheck: true,
  });
  // Outputs first: scure refuses outputs after a finalized input
  tx.addOutput({ script: bytes(`0014${'11'.repeat(20)}`), amount: paid });
  tx.addInput({
    txid: lockup.transactionId,
    index: vout,
    finalScriptWitness: witness,
  });
  return { txid: tx.id, hex: tx.hex };
};

const sig = new Uint8Array(64).fill(1);
const control = new Uint8Array(33).fill(2);

const record = (
  kind: RescueRecord['kind'],
  tx: { txid: string; hex: string },
): RescueRecord => ({ id: '39A4obuRRMXN', kind, ...tx });

describe('RescueRecords', () => {
  test('adopts a refund that spends the lockup by its refund leaf', () => {
    const tx = spend([sig, bytes(refundLeaf), control]);
    expect(checkRescueSpend(record('refund', tx), lockup)).toEqual({
      ok: true,
      vin: 0,
      minerFee: 346,
    });
  });

  test('adopts a claim with the swap preimage and gives the preimage back', () => {
    const tx = spend([sig, preimage, bytes(claimLeaf), control]);
    expect(checkRescueSpend(record('claim', tx), lockup)).toEqual({
      ok: true,
      vin: 0,
      minerFee: 346,
      preimage,
    });
  });

  test('refuses a refund record that spends by the claim leaf', () => {
    const tx = spend([sig, preimage, bytes(claimLeaf), control]);
    expect(checkRescueSpend(record('refund', tx), lockup)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('refund leaf'),
    });
  });

  test('refuses a claim whose preimage is not the swap preimage', () => {
    const tx = spend([sig, randomBytes(32), bytes(claimLeaf), control]);
    expect(checkRescueSpend(record('claim', tx), lockup)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('preimage'),
    });
  });

  test('refuses a transaction that spends another output', () => {
    const tx = spend([sig, bytes(refundLeaf), control], 0);
    expect(checkRescueSpend(record('refund', tx), lockup)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('does not spend the lockup'),
    });
  });

  test('refuses a record whose transaction id does not match', () => {
    const tx = spend([sig, bytes(refundLeaf), control]);
    expect(
      checkRescueSpend(
        record('refund', { ...tx, txid: lockup.transactionId }),
        lockup,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('its id') });
  });

  test('refuses what is not a transaction', () => {
    expect(
      checkRescueSpend(
        record('refund', { txid: lockup.transactionId, hex: 'zz' }),
        lockup,
      ),
    ).toMatchObject({ ok: false });
  });

  describe('reading rescued.json', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swapsha-rescued-'));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('no file means no records', () => {
      expect(readRescueRecords(dir)).toEqual([]);
    });

    test('keeps only well-formed records', () => {
      const good = record('refund', spend([sig, bytes(refundLeaf), control]));
      fs.writeFileSync(
        path.join(dir, rescuedFileName),
        JSON.stringify({
          version: 1,
          rescues: [good, { id: 'x', kind: 'steal', txid: 'a', hex: 'b' }, 7],
        }),
      );
      expect(readRescueRecords(dir)).toEqual([good]);
    });

    test('refuses a file without a list of rescues', () => {
      fs.writeFileSync(path.join(dir, rescuedFileName), '{"version":1}');
      expect(() => readRescueRecords(dir)).toThrow('no list of rescues');
    });
  });
});
