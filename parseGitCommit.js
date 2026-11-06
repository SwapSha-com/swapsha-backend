/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('fs');
const childProcess = require('child_process');

const executeCommand = (command) => {
  return childProcess.execSync(command, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
};

// SwapSha (StartOS package): the package builds from a copy of this repo with
// no .git, and passes the commit in SWAPSHA_COMMIT instead. Without either,
// the version carries no commit rather than failing the install or build.
const fromEnv = process.env.SWAPSHA_COMMIT;

const getCommitHash = () => {
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv.slice(0, 8);
  }
  try {
    const result = executeCommand('git log -1');
    return result.slice(7, 7 + 8);
  } catch {
    return '';
  }
};

const isDirty = () => {
  if (fromEnv !== undefined && fromEnv !== '') {
    return false;
  }
  try {
    const result = executeCommand('git status --short');
    return result.length > 0;
  } catch {
    return false;
  }
};

const versionFilePath = `${__dirname}/lib/Version.ts`;

try {
  // Delete the version file if it exists
  if (fs.existsSync(versionFilePath)) {
    fs.unlinkSync(versionFilePath);
  }
} catch (error) {
  console.error(`Could not delete file: ${versionFilePath}`, error);
}

const commitHash = getCommitHash();

fs.writeFileSync(
  versionFilePath,
  `export default '${commitHash === '' ? '' : '-' + commitHash}${
    isDirty() ? '-dirty' : ''
  }';\n`,
);
