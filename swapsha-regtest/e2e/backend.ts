/**
 * Start and hard-kill the SwapSha backend from a test, for the crash test.
 *
 * The backend runs in its own process group, so SIGKILL to the group takes
 * down boltzd and its boltzr sidecar together, with no shutdown handlers run.
 * That is the same as pulling the power on the Start9.
 */
import { type ChildProcess, execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { API, LIVE, sleep } from './helpers';

const DATA = LIVE ? 'swapsha-testnet4/data' : 'swapsha-regtest/data';
const PORTS = LIVE
  ? [9100, 9101, 9103, 9104, 9105]
  : [9000, 9001, 9003, 9004, 9005];
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
  for (const p of PORTS) {
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
export const configWithWallet = (symbol: 'SHA256' | 'BTC', wallet: string) => {
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
 * A copy of boltz.conf with D30 pace bounds on one currency, for the stall
 * guard test. Inserted as an inline table right after the symbol line, so it
 * stays inside that currency's table.
 */
export const configWithPace = (
  symbol: 'SHA256' | 'BTC',
  pace: {
    fastMinutesPerBlock: number;
    slowMinutesPerBlock: number;
    maxTipAgeMinutes?: number;
  },
) => {
  const base = fs.readFileSync(`${DATA}/boltz.conf`, 'utf8');
  const line = `symbol = "${symbol}"`;
  if (!base.includes(line))
    throw new Error(`no ${symbol} currency in boltz.conf`);
  const fields = Object.entries(pace)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k} = ${v}`)
    .join(', ');
  const path = `${DATA}/pace-${symbol}.conf`;
  fs.writeFileSync(path, base.replace(line, `${line}\npace = { ${fields} }`));
  return path;
};

/** Copy the checked-in boltz.conf into the data dir, as run.sh does. */
export const freshConfig = () => {
  const src = LIVE
    ? 'swapsha-testnet4/boltz.conf'
    : 'swapsha-regtest/boltz.conf';
  fs.copyFileSync(src, `${DATA}/boltz.conf`);
};

/**
 * boltzd runs the compiled code in dist/, and only run.sh compiles it. A suite
 * run after `git am` without compiling tests the old code: on Nov 5,
 * Crash.spec ran the build from patch 0037 with 0040 applied, and failed for
 * a fix it never loaded. `compile:typescript` writes the commit it built from
 * into dist/lib/Version.js. Refuse to start when lib/ has changed since then.
 *
 * The same for the sidecar boltzd starts (target/debug/boltzr), which only
 * `cargo build -p boltzr` rebuilds. Cargo lists every source file the binary
 * was built from in boltzr.d next to it, and rebuilds by file times, so one
 * of those files being newer than the binary is a change not built yet.
 */
export const checkBuild = () => {
  const fail = (why: string, fix = 'npm run compile:typescript'): never => {
    throw new Error(`${why}. Run ${fix}, then the suite again.`);
  };

  const sidecar = 'target/debug/boltzr';
  let sources: string[] = [];
  try {
    const listed = fs.readFileSync(`${sidecar}.d`, 'utf8');
    sources = listed
      .slice(listed.indexOf(': ') + 2)
      .split(/(?<!\\)\s+/)
      .filter((f) => f !== '')
      .map((f) => f.replace(/\\ /g, ' '));
  } catch {
    return fail(`no sidecar build in ${sidecar}`, 'cargo build -p boltzr');
  }
  const sidecarBuilt = fs.statSync(sidecar).mtimeMs;
  const newer = sources.find(
    (f) => fs.existsSync(f) && fs.statSync(f).mtimeMs > sidecarBuilt,
  );
  if (newer !== undefined) {
    return fail(
      `${sidecar} is older than ${newer.replace(`${process.cwd()}/`, '')}`,
      'cargo build -p boltzr',
    );
  }

  let version = '';
  try {
    version = fs.readFileSync('dist/lib/Version.js', 'utf8');
  } catch {
    return fail('no build in dist/');
  }
  const built = version.match(/'-([0-9a-f]{8})/)?.[1];
  if (built === undefined)
    return fail('dist/ does not say what it was built from');
  try {
    execSync(`git diff --quiet ${built} HEAD -- lib`, { stdio: 'ignore' });
  } catch {
    // Exit 1: lib/ differs. Exit 128: that commit is gone (a rebase).
    return fail(
      `dist/ was built from ${built}, and lib/ has changed since (or that commit is gone)`,
    );
  }
  try {
    execSync('git diff --quiet HEAD -- lib', { stdio: 'ignore' });
  } catch {
    console.warn('lib/ has uncommitted changes; dist/ may not include them');
  }
};

/**
 * Start boltzd (which starts the sidecar) and wait until the API answers.
 * Throws StartupRefused if it exits first.
 */
export const start = async (configPath = `${DATA}/boltz.conf`) => {
  if (await apiUp()) throw new Error('a backend is already running on 9001');
  checkBuild();
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
