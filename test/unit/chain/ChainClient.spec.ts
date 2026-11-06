import Logger from '../../../lib/Logger';
import { resetKnownTransactions } from '../../../lib/blake2b/PrunedHistory';
import ChainClient from '../../../lib/chain/ChainClient';
import type Sidecar from '../../../lib/sidecar/Sidecar';

jest.mock('../../../lib/chain/RpcClient', () => {
  return jest.fn().mockImplementation(() => ({}));
});

jest.mock('../../../lib/chain/Rebroadcaster', () => {
  return jest.fn().mockImplementation(() => ({}));
});

describe('ChainClient', () => {
  const mockSidecar = {
    on: jest.fn(),
  } as unknown as Sidecar;

  const baseConfig = {
    host: '127.0.0.1',
    port: 8332,
    user: 'bitcoin',
    password: 'password',
  };

  test.each`
    network      | expectedIsRegtest
    ${'mainnet'} | ${false}
    ${'testnet'} | ${false}
    ${'signet'}  | ${false}
    ${'regtest'} | ${true}
  `(
    'should construct with network $network',
    ({ network, expectedIsRegtest }) => {
      const symbol = 'BTC';
      const client = new ChainClient(
        Logger.disabledLogger,
        mockSidecar,
        network,
        baseConfig,
        symbol,
      );

      expect(client.symbol).toEqual(symbol);
      expect(client.isRegtest).toEqual(expectedIsRegtest);
    },
  );

  describe('getRawTransaction on a node without txindex (D38)', () => {
    // A three-input Taproot spend from the SHA256 regtest chain
    const TX =
      '020000000001035fa5f26110db753e624b9a61b3139302356f3e5ebd71cd024d33e9c85a07279c0000000000fefffffffa8793cff93a06d4bcbdaff1b3407509a39b13615a77352bdf40930e972085c60000000000feffffff4da9729af7be8581883a5b1ea41b795d38f99c783dc061a549e7e51fb1d36e550000000000feffffff027e0a0300000000001976a914ead38539f2070c0faa99df6366434792452b518b88ac7b83010000000000225120fa20265bd8502042e5d22a2394903ccdece69bc7197c05e81c5519af42da6fcf0140b26cb92b7c205fc148265f81fa6f5174576adccfd99d6090db23f8009b0664f083c6b44be2fa35794d8d84184cc56301ea28fedfc742492ba5beb231eb05b9cd0140f46ce64bb0bd62fb59f91e4b033ca5a9c4fa3be05c6c2d91171ba0efce63b8679c3d576dbd28bf550418f4c770d4ca138b71a36ac43c9bdf6a513b10ebe1aeab0140b659c0ab7e5e1595b143b461ba337a11cad59c026384ec8bc641c18a42b98dad75ee6f377d66ee824cfcafcbad1122ba632c4b1fb77819a0759ee8b06e0164dc47050000';
    const TXID =
      'c271addd4f5e23c2c60942d82763b878e5aca1861b5556a68627549e3cdccbec';
    const TIP = 500;
    const LOCKED_AT = 470;

    /** A pruned node that knows the lockup only as an unspent output */
    const prunedClient = () => {
      const client = new ChainClient(
        Logger.disabledLogger,
        mockSidecar,
        'regtest',
        baseConfig,
        'SHA256',
      );
      const request = jest.fn(
        async (method: string, params: unknown[] = []) => {
          switch (method) {
            case 'getrawtransaction':
              if (params.length === 1) {
                throw new Error(
                  'No such mempool transaction. Use -txindex or provide a block hash to enable blockchain transaction queries.',
                );
              }
              if (params[2] !== `block${LOCKED_AT}`) {
                throw new Error(
                  'No such transaction found in the provided block',
                );
              }
              return {
                txid: TXID,
                hex: TX,
                confirmations: TIP - LOCKED_AT + 1,
                blockhash: params[2],
              };
            case 'gettransaction':
              throw new Error('Invalid or non-wallet transaction id');
            case 'gettxout':
              return params[1] === 1
                ? { confirmations: TIP - LOCKED_AT + 1 }
                : null;
            case 'getblockchaininfo':
              return { blocks: TIP };
            case 'getblockhash':
              return `block${params[0]}`;
            default:
              throw new Error(`unexpected ${method}`);
          }
        },
      );
      (client as unknown as { client: { request: jest.Mock } }).client = {
        request,
      };
      return client;
    };

    beforeEach(() => resetKnownTransactions());

    test("the swap's lockup output places a lockup it never saw", async () => {
      await expect(
        prunedClient().getRawTransaction(TXID, { vout: 1 }),
      ).resolves.toEqual(TX);
    });

    test('without a hint or a seen copy it still fails', async () => {
      await expect(prunedClient().getRawTransaction(TXID)).rejects.toThrow(
        /txindex/,
      );
    });
  });
});
