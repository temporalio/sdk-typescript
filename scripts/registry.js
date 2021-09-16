const path = require('path');
const { tmpdir } = require('os');
const { copy, readFile, mkdtemp, pathExists } = require('fs-extra');
const { spawn: spawnChild } = require('child_process');
const arg = require('arg');
const { Tail } = require('tail');
const { shell, sleep, kill } = require('./utils');

async function untilExists(file, attempts, sleepDuration = 1000) {
  for (let attempt = 1; attempt < attempts; attempt++) {
    if (await pathExists(file)) {
      return;
    }
    await sleep(sleepDuration);
  }
  throw new Error(`Path ${file} does not exist`);
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
    return kill(this.proc);
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
    await registry.destroy();
  }
}

async function createTempRegistryDir() {
  const dir = await mkdtemp(path.resolve(tmpdir(), 'registry'), { encoding: 'utf8' });
  console.log('Created registry dir', dir);
  return dir;
}

/**
 * Parse and return command line arguments
 */
async function getArgs() {
  const opts = arg(
    {
      '--registry-dir': String,
    },
    { permissive: true }
  );
  const registryDir = opts['--registry-dir'] || (await createTempRegistryDir());
  return { registryDir, initArgs: opts._.length > 0 ? ['--', ...opts._] : [] };
}

module.exports = { getArgs, withRegistry };
