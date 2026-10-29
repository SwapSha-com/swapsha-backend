/**
 * Start and hard-kill the SwapSha backend from a test, for the crash test.
 *
 * The backend runs in its own process group, so SIGKILL to the group takes
 * down boltzd and its boltzr sidecar together, with no shutdown handlers run.
 * That is the same as pulling the power on the Start9.
 */
import { type ChildProcess, execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { API, sleep } from './helpers';

const DATA = 'swapsha-regtest/data';
export const LOG = `${DATA}/crash-backend.log`;

let child: ChildProcess | undefined;

export const apiUp = async () => {
  try {
    return (await fetch(`${API}/swap/chain`)).ok;
  } catch {
    return false;
  }
};

/** PIDs listening on our backend ports, from any process (run.sh included). */
const listeners = (): number[] => {
  const pids = new Set<number>();
  for (const p of [9000, 9001, 9003, 9004, 9005]) {
    try {
      execSync(`lsof -ti tcp:${p} -sTCP:LISTEN`, { encoding: 'utf8' })
        .split('\n')
        .filter((l) => l.trim() !== '')
        .forEach((l) => pids.add(Number(l)));
    } catch {
      // nothing listening
    }
  }
  return [...pids];
};

const waitPortsFree = async () => {
  for (let i = 0; i < 30; i++) {
    if (listeners().length === 0) return;
    await sleep(500);
  }
  throw new Error(`backend ports still busy: ${listeners().join(', ')}`);
};

/** SIGKILL the backend and sidecar, whoever started them. */
export const crash = async () => {
  if (child?.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
    child = undefined;
  }
  for (const pid of listeners()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await waitPortsFree();
  fs.appendFileSync(
    LOG,
    `\n===== SIGKILL at ${new Date().toISOString()} =====\n`,
  );
};

/** Start boltzd (which starts the sidecar) and wait until the API answers. */
export const start = async () => {
  if (await apiUp()) throw new Error('a backend is already running on 9001');
  const out = fs.openSync(LOG, 'a');
  child = spawn(
    'node',
    ['bin/boltzd', '--datadir', DATA, '--configpath', `${DATA}/boltz.conf`],
    { detached: true, stdio: ['ignore', out, out] },
  );
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null)
      throw new Error(`backend exited with ${child.exitCode}, see ${LOG}`);
    if (await apiUp()) {
      // The API listens before the startup rescan finishes; give it a moment.
      await sleep(3000);
      return;
    }
    await sleep(500);
  }
  throw new Error(`backend did not come up, see ${LOG}`);
};

/** Clean stop at the end of the run (SIGINT, as Ctrl+C would). */
export const stop = async () => {
  if (child?.pid === undefined) return;
  const pid = child.pid;
  await new Promise<void>((resolve) => {
    child!.once('exit', () => resolve());
    process.kill(-pid, 'SIGINT');
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // gone
      }
      resolve();
    }, 15_000);
  });
  child = undefined;
};
