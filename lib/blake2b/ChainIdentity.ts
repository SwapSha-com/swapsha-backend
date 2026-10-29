import { BlockHeader } from 'boltz-core';
import { formatError } from '../Utils';
import type ChainClient from '../chain/ChainClient';

type Deployment = { height?: number; active?: boolean };

type DeploymentInfo = {
  // Knots 29.4.1+ reports the PoW change next to `deployments`, not inside it
  blake2b?: Deployment;
  deployments?: Record<string, Deployment>;
};

export class ChainIdentityError extends Error {}

/**
 * Refuse to run when a currency's node is on the other chain.
 *
 * A BLAKE2b currency (`blake2b = true`) must be connected to a node that has
 * activated the BLAKE2b deployment, whose fork block carries a v2 header, and
 * (on mainnet) whose fork block is the known one. Any other Bitcoin currency
 * must be connected to a node where that deployment is not active. Pointing
 * BTC at a BLAKE2b node, or XBT at a SHA-256 node, stops startup.
 *
 * Mainnet BLAKE2b is refused until SWAPSHA_ALLOW_MAINNET=1 (Blueprint D7).
 */
export const verifyChainIdentity = async (
  client: ChainClient,
  expectBlake2b: boolean,
  network: string,
): Promise<string> => {
  const symbol = client.symbol;
  let info: DeploymentInfo;
  try {
    info = await client.rpc<DeploymentInfo>('getdeploymentinfo');
  } catch (error) {
    if (expectBlake2b) {
      throw new ChainIdentityError(
        `${symbol}: getdeploymentinfo failed: ${formatError(error)}`,
      );
    }
    // Nodes too old for getdeploymentinfo cannot be on the BLAKE2b chain
    info = {};
  }
  const deployment = info.blake2b ?? info.deployments?.blake2b;
  const active = deployment?.active === true;
  const isMainnet = network.toLowerCase() === 'mainnet';

  if (!expectBlake2b) {
    if (active) {
      throw new ChainIdentityError(
        `${symbol} is configured as a SHA-256 currency but its node follows the BLAKE2b chain (deployment active at ${deployment?.height}). Set blake2b = true or point it at a SHA-256 node.`,
      );
    }
    return `${symbol}: SHA-256 chain (no active BLAKE2b deployment)`;
  }

  if (isMainnet && process.env.SWAPSHA_ALLOW_MAINNET !== '1') {
    throw new ChainIdentityError(
      `${symbol} is a BLAKE2b currency on mainnet. Mainnet stays off until Phase 5 (set SWAPSHA_ALLOW_MAINNET=1 to override).`,
    );
  }

  if (!active || deployment?.height === undefined) {
    throw new ChainIdentityError(
      `${symbol} is configured with blake2b = true but its node has no active BLAKE2b deployment. Is it a Knots 29.4.1+ node on the BLAKE2b chain? getdeploymentinfo returned: ${JSON.stringify(info)}`,
    );
  }

  const forkHash = await client.getBlockhash(deployment.height);
  const rawHeader = await client.rpc<string>('getblockheader', [
    forkHash,
    false,
  ]);
  const header = BlockHeader.parseBlockHeader(rawHeader);
  if (!header.isV2 || BlockHeader.blockHashHex(header) !== forkHash) {
    throw new ChainIdentityError(
      `${symbol} fork block ${deployment.height} is not a valid v2 BLAKE2b header`,
    );
  }

  if (isMainnet) {
    if (
      deployment.height !== BlockHeader.MAINNET_FORK.height ||
      forkHash !== BlockHeader.MAINNET_FORK.hash
    ) {
      throw new ChainIdentityError(
        `${symbol} fork block ${deployment.height} ${forkHash} is not the BLAKE2b mainnet fork block`,
      );
    }
  }

  return `${symbol}: BLAKE2b chain, fork block ${deployment.height} ${forkHash}`;
};

/** Height of the BLAKE2b fork as the node reports it, if it has one. */
export const blake2bForkHeight = async (
  client: ChainClient,
): Promise<number | undefined> => {
  const info = await client.rpc<DeploymentInfo>('getdeploymentinfo');
  const deployment = info.blake2b ?? info.deployments?.blake2b;
  return deployment?.active === true ? deployment.height : undefined;
};
