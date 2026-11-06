import type Logger from '../../../../lib/Logger';
import { setSighashMode } from '../../../../lib/blake2b/SighashMode';
import type { IChainClient } from '../../../../lib/chain/ChainClient';
import CoreWalletProvider from '../../../../lib/wallet/providers/CoreWalletProvider';
import { regtest } from '../../../Networks';

// D38 S4: after every send, the BLAKE2b wallet's signatures are checked for
// SIGHASH_UNIFIED. A miss is logged, not refused (D26 still holds).

const G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const OUTPUT = `0014${'22'.repeat(20)}`;
// OUTPUT as a regtest address (bech32, witness v0, 20 bytes of 0x22)
const TO = 'bcrt1qyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zs4w3j0';

/** One P2PKH input signed with `hashType`, paying TO */
const spend = (hashType: string) =>
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
    OUTPUT,
    '00000000',
  ].join('');

const provider = (symbol: string, hex: string) => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
    silly: jest.fn(),
  };
  const chainClient = {
    symbol,
    sendToAddress: jest.fn(async () => 'sent'),
    getWalletTransaction: jest.fn(async () => ({ hex, fee: -0.00001 })),
    // In the mempool, so nothing is saved for rebroadcast
    getRawTransaction: jest.fn(async () => hex),
    estimateFee: jest.fn(async () => 2),
  } as unknown as IChainClient;
  return {
    logger,
    wallet: new CoreWalletProvider(
      logger as unknown as Logger,
      chainClient,
      regtest,
    ),
  };
};

describe('CoreWalletProvider opt-in check (D38 S4)', () => {
  beforeAll(() => {
    setSighashMode('BTC', 'unified');
    setSighashMode('SHA256', 'legacy');
  });

  afterAll(() => setSighashMode('BTC', 'legacy'));

  test('a BLAKE2b send signed ALL|UNIFIED logs nothing', async () => {
    const { logger, wallet } = provider('BTC', spend('21'));
    const sent = await wallet.sendToAddress(TO, 1_000, 2, 'lockup');
    expect(sent.vout).toEqual(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a BLAKE2b send with an input signed ALL is logged, and still returned', async () => {
    const { logger, wallet } = provider('BTC', spend('01'));
    const sent = await wallet.sendToAddress(TO, 1_000, 2, 'lockup');
    expect(sent.transactionId).toEqual('sent');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /BTC wallet transaction sent: input\(s\) 0 carry no SIGHASH_UNIFIED/,
      ),
    );
  });

  test('the SHA-256 wallet is not checked: it has no opt-in', async () => {
    const { logger, wallet } = provider('SHA256', spend('01'));
    await wallet.sendToAddress(TO, 1_000, 2, 'lockup');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
