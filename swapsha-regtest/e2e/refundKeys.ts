/**
 * testnet4: the user's refund key for a swap, saved on this Mac before the
 * user locks anything. The suites keep the keys in memory only, so a test that
 * failed or was stopped could not refund the user's lockup afterwards (two
 * lockups of 100,000 test sats were lost that way on Nov 9). Rescue.spec.ts
 * refunds from a saved file with SWAPSHA_REFUND_FILE.
 */
import { hex } from '@scure/base';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CreatedSwap, SwapData } from './helpers';

const DIR = join(homedir(), 'Claude', 'swapsha', 'testnet4', 'refund-keys');

export const refundFile = (id: string) => join(DIR, `${id}.json`);

type Saved = {
  id: string;
  from: CreatedSwap['from'];
  to: CreatedSwap['to'];
  lockupDetails: SwapData;
  refundKey: string;
  lockupId: string | null;
};

/** Writes (or rewrites, once the lockup is known) the swap's refund file. */
export const saveUserRefund = async (swap: CreatedSwap, lockupId?: string) => {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  const saved: Saved = {
    id: swap.id,
    from: swap.from,
    to: swap.to,
    lockupDetails: swap.lockupDetails,
    refundKey: hex.encode(swap.refundKey),
    lockupId: lockupId ?? null,
  };
  const file = refundFile(swap.id);
  await writeFile(file, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  return file;
};

/** What userRefund needs, from a saved file. */
export const loadUserRefund = async (file: string) => {
  const saved = JSON.parse(await readFile(file, 'utf8')) as Saved;
  if (saved.lockupId === null) {
    throw new Error(`${file}: the user never locked anything for this swap`);
  }
  const swap: CreatedSwap = {
    id: saved.id,
    from: saved.from,
    to: saved.to,
    lockupDetails: saved.lockupDetails,
    // Not used by userRefund
    claimDetails: saved.lockupDetails,
    claimKey: new Uint8Array(32),
    refundKey: hex.decode(saved.refundKey),
    preimage: new Uint8Array(32),
  };
  return { swap, lockupId: saved.lockupId };
};
