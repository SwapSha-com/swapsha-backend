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

/** Thrown when boltzd exits during startup; carries what it logged. */
export class StartupRefused extends Error {
  constructor(
    public readonly code: number | null,
    public readonly log: string,
  ) {
    super(`backend exited with ${code} during startup, see ${LOG}`);
  }
}

/** A copy of boltz.conf with the wallet of one currency swapped out. */
export const configWithWallet = (symbol: 'BTC' | 'XBT', wallet: string) => {
  const base = fs.readFileSync(`${DATA}/boltz.conf`, 'utf8');
  const sections = base.split('[[currencies]]');
  const idx = sections.findIndex((sec) =>
    new RegExp(`symbol = "${symbol}"`).test(sec),
  );
  if (idx < 1) throw new Error(`no ${symbol} currency in boltz.conf`);
  sections[idx] = sections[idx].replace(
    /wallet = "[^"]*"/,
    `wallet = "${wallet}"`,
  );
  const path = `${DATA}/guard-${symbol}-${wallet}.conf`;
  fs.writeFileSync(path, sections.join('[[currencies]]'));
  return path;
};

/**
 * Start boltzd (which starts the sidecar) and wait until the API answers.
 * Throws StartupRefused if it exits first.
 */
export const start = async (configPath = `${DATA}/boltz.conf`) => {
  if (await apiUp()) throw new Error('a backend is already running on 9001');
  const from = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
  const out = fs.openSync(LOG, 'a');
  fs.writeSync(out, `\n===== start with ${configPath} =====\n`);
  child = spawn(
    'node',
    ['bin/boltzd', '--datadir', DATA, '--configpath', configPath],
    { detached: true, stdio: ['ignore', out, out] },
  );
  const logged = () => {
    const buf = fs.readFileSync(LOG);
    return buf.subarray(from).toString('utf8');
  };
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) {
      const code = child.exitCode;
      // The sidecar may outlive a crashed boltzd
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // gone
      }
      child = undefined;
      await waitPortsFree();
      throw new StartupRefused(code, logged());
    }
    if (await apiUp()) {
      // The API listens before the startup rescan finishes; give it a moment.
      await sleep(3000);
      return logged();
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
    const force = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // gone
      }
      resolve();
    }, 15_000);
    child!.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    process.kill(-pid, 'SIGINT');
  });
  child = undefined;
};
