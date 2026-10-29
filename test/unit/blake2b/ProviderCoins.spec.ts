import { ChainIdentityError } from '../../../lib/blake2b/ChainIdentity';
import { verifyPostForkCoins } from '../../../lib/blake2b/ProviderCoins';
import type { IChainClient } from '../../../lib/chain/ChainClient';

const client = (tip: number, confirmations: number[]) =>
  ({
    symbol: 'BTC',
    getBlockchainInfo: jest.fn(async () => ({ blocks: tip })),
    listUnspent: jest.fn(async () =>
      confirmations.map((c, i) => ({
        txid: `tx${i}`,
        vout: 0,
        amount: 1,
        confirmations: c,
      })),
    ),
  }) as unknown as IChainClient;

describe('verifyPostForkCoins', () => {
  test('passes when every coin was created at or after the fork', async () => {
    // tip 300: confirmations 101 -> height 200 (the fork block itself)
    await expect(
      verifyPostForkCoins(client(300, [1, 50, 101]), 200),
    ).resolves.toContain('all after the fork at 200');
  });

  test('refuses a coin from before the fork', async () => {
    // confirmations 102 -> height 199
    await expect(
      verifyPostForkCoins(client(300, [1, 102]), 200),
    ).rejects.toThrow(ChainIdentityError);
  });

  test('passes an empty wallet', async () => {
    await expect(verifyPostForkCoins(client(300, []), 200)).resolves.toContain(
      '0 confirmed',
    );
  });
});
