import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { cooperativeSighash } from 'boltz-core';
import { hashForWitnessV1 } from '../../../lib/Core';
import {
  setSighashMode,
  sighashModeFor,
} from '../../../lib/blake2b/SighashMode';
import { CurrencyType } from '../../../lib/consts/Enums';
import type { Currency } from '../../../lib/wallet/WalletManager';

const p2tr = (x: Uint8Array) => new Uint8Array([0x51, 0x20, ...x]);

// A funding transaction and a spend of its output 0.
const key = secp256k1.utils.randomSecretKey();
const xonly = secp256k1.getPublicKey(key).slice(1);
const prev = new Transaction({ version: 2 });
prev.addInput({ txid: new Uint8Array(32).fill(1), index: 0 });
prev.addOutput({ script: p2tr(xonly), amount: 50_000n });
const prevHex = hex.encode(prev.unsignedTx);

const spend = new Transaction({ version: 2 });
spend.addInput({ txid: hex.decode(prev.id), index: 0, sequence: 0xfffffffd });
spend.addOutput({ script: p2tr(xonly), amount: 49_000n });

const currency = (symbol: string) =>
  ({
    symbol,
    type: CurrencyType.BitcoinLike,
    chainClient: { getRawTransaction: jest.fn(async () => prevHex) },
  }) as unknown as Currency;

const spent = [{ script: p2tr(xonly), amount: 50_000n }];

describe('hashForWitnessV1 per sighash mode', () => {
  beforeAll(() => {
    setSighashMode('BTC', 'legacy');
    setSighashMode('XBT', 'unified');
  });

  test('unknown symbols default to legacy', () => {
    expect(sighashModeFor('DOGE')).toEqual('legacy');
  });

  test('BTC hashes with BIP341', async () => {
    const got = await hashForWitnessV1(currency('BTC'), spend, 0);
    expect(hex.encode(got)).toEqual(
      hex.encode(cooperativeSighash(spend, 0, spent, 'legacy')),
    );
  });

  test('XBT hashes with SIGHASH_UNIFIED', async () => {
    const got = await hashForWitnessV1(currency('XBT'), spend, 0);
    expect(hex.encode(got)).toEqual(
      hex.encode(cooperativeSighash(spend, 0, spent, 'unified')),
    );
    expect(hex.encode(got)).not.toEqual(
      hex.encode(cooperativeSighash(spend, 0, spent, 'legacy')),
    );
  });

  test('XBT refuses hash types other than ALL', async () => {
    await expect(
      hashForWitnessV1(currency('XBT'), spend, 0, undefined, undefined, 0x83),
    ).rejects.toThrow('unsupported hash type');
  });
});
