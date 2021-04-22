const path = require('path');
const { spawn: spawnChild, spawnSync } = require('child_process');
const arg = require('arg');
const { shell, sleep, kill, waitOnChild, ChildProcessError } = require('./utils');

const npm = /^win/.test(process.platform) ? 'npm.cmd' : 'npm';

function createWorker(workdir) {
  return spawnChild(npm, ['start'], {
    cwd: workdir,
    stdio: 'inherit',
    shell,
    detached: true,
  });
}

async function withWorker(workdir, fn) {
  console.log('Starting worker');
  const worker = createWorker(workdir);
  try {
    return await fn();
  } finally {
    await kill(worker);
  }
}

async function test(workdir) {
  const { status, output } = spawnSync('node', [path.join(workdir, 'lib/worker/schedule-workflow.js')], {
    cwd: workdir,
    shell,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  if (status !== 0) {
    throw new Error('Failed to run workflow');
  }
  if (output[1] !== 'Hello, Temporal!\n') {
    throw new Error(`Invalid output: "${output[1]}"`);
  }
}

async function main() {
  const opts = arg({
    '--work-dir': String,
  });
  const workdir = opts['--work-dir'];
  if (!workdir) {
    throw new Error('Missing required option --work-dir');
  }

  await withWorker(workdir, () => test(workdir));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
