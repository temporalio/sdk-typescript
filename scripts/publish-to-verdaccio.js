const arg = require('arg');
const path = require('path');
const { tmpdir } = require('os');
const { copy, readFile, mkdtemp, pathExists } = require('fs-extra');
const { spawnSync, spawn: spawnChild } = require('child_process');
const { Tail } = require('tail');

const shell = process.platform === 'win32';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function untilExists(file, attempts, sleepDuration = 1000) {
  for (let attempt = 1; attempt < attempts; attempt++) {
    if (await pathExists(file)) {
      return;
    }
    await sleep(sleepDuration);
  }
  throw new Error(`Path ${file} does not exist`);
}

class ChildProcessError extends Error {
  constructor(message, code, signal) {
    super(message);
    this.name = 'ChildProcessError';
    this.code = code;
    this.signal = signal;
  }
}

async function waitOnChild(child) {
  return new Promise((resolve, reject) => {
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new ChildProcessError('Process failed', code, signal));
      }
    });
    child.on('error', reject);
  });
}

async function killGroup(child, signal = 'SIGINT') {
  // TODO: support windows (-pid is unix only)
  process.kill(-child.pid, signal);
  try {
    await waitOnChild(child);
  } catch (err) {
    if (!(err.name === 'ChildProcessError' && err.signal === signal)) {
      throw err;
    }
  }
}

class Registry {
  constructor(proc, workdir) {
    this.proc = proc;
    this.workdir = workdir;
  }

  static async create(workdir) {
    await copy(path.resolve(__dirname, '../etc/verdaccio-config.yaml'), path.resolve(workdir, 'verdaccio.yaml'));

    const proc = spawnChild('npx', ['verdaccio', '-c', 'verdaccio.yaml'], {
      cwd: workdir,
      stdio: 'inherit',
      shell,
      detached: true,
    });
    return new this(proc, workdir);
  }

  async ready() {
    const logPath = path.resolve(this.workdir, 'verdaccio.log');
    await untilExists(logPath, 60);
    const tail = new Tail(logPath, {
      fromBeginning: true,
    });
    try {
      await new Promise((resolve, reject) => {
        tail.on('line', (line) => {
          const parsed = JSON.parse(line);
          if (parsed.addr) {
            resolve();
          }
        });

        tail.on('error', reject);
        setTimeout(async () => {
          let contents;
          try {
            contents = await readFile(logPath, 'utf8');
          } catch (e) {
            contents = `Error ${e}`;
          }
          reject(new Error(`Timed out waiting for verdaccio - ${contents}`));
        }, 60 * 1000);
      });
    } finally {
      tail.unwatch();
    }
  }

  async destroy() {
    return killGroup(this.proc);
  }
}

async function withRegistry(testDir, fn) {
  console.log('Starting local registry');
  const registry = await Registry.create(testDir);
  try {
    await registry.ready();
    console.log('Local registry ready');
    return await fn();
  } finally {
    try {
      await registry.destroy();
    } catch (e) {
      if (e.syscall === 'kill' && e.errno === 'ESRCH') void 1; // ignore
    }
  }
}

async function createTempRegistryDir() {
  const dir = await mkdtemp(path.resolve(tmpdir(), 'registry'), { encoding: 'utf8' });
  console.log('Created registry dir', dir);
  return dir;
}

async function main() {
  const opts = arg({
    '--registry-dir': String,
  });
  const registryDir = opts['--registry-dir'] || (await createTempRegistryDir());
  await withRegistry(registryDir, async () => {
    spawnSync('npx', ['lerna', 'publish', 'from-package', '--yes', '--registry', 'http://localhost:4873/'], {
      stdio: 'inherit',
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
