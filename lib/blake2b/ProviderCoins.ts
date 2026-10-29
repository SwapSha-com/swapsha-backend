import type { IChainClient } from '../chain/ChainClient';
import { ChainIdentityError } from './ChainIdentity';

/**
 * Blueprint 4.4 / D26: the backend's wallets must hold only coins created
 * after the fork. A pre-fork coin exists on both chains. The SHA-256 chain has
 * no SIGHASH_UNIFIED, and the Knots wallet does not opt in when it spends a
 * Taproot output by key path, so a transaction spending a pre-fork coin from
 * either wallet could be replayed onto the other chain. Refuse to start.
 *
 * Unconfirmed outputs are skipped: they can only spend coins the wallet
 * already holds, and those are checked.
 */
export const verifyPostForkCoins = async (
  client: IChainClient,
  forkHeight: number,
): Promise<string> => {
  const [utxos, info] = await Promise.all([
    client.listUnspent(1),
    client.getBlockchainInfo(),
  ]);
  const tip = info.blocks;

  const preFork = utxos.filter(
    (utxo) => tip - utxo.confirmations + 1 < forkHeight,
  );
  if (preFork.length > 0) {
    const total = preFork.reduce((sum, utxo) => sum + utxo.amount, 0);
    throw new ChainIdentityError(
      `${client.symbol} wallet holds ${preFork.length} coin(s) from before the BLAKE2b fork at ${forkHeight} (${total} total, e.g. ${preFork[0].txid}:${preFork[0].vout}). Move them out or fund a fresh wallet with post-fork coins only.`,
    );
  }

  return `${client.symbol} wallet: ${utxos.length} confirmed coin(s), all after the fork at ${forkHeight}`;
};
