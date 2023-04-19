const path = require('path');
const { tmpdir } = require('os');
const { mkdtemp } = require('fs-extra');
const arg = require('arg');
const { runServer } = require('verdaccio');
const { mkdirSync } = require('fs');

class Registry {
  constructor(app, workdir) {
    this.app = app;
    this.workdir = workdir;
  }

  static async create(workdir) {
    mkdirSync(workdir, { recursive: true });

    const app = await runServer({
      self_path: workdir,
      storage: path.resolve(workdir, 'storage'),

      packages: {
        '@temporalio/*': {
          access: '$all',
          publish: '$all',
          unpublish: '$all',
        },
        temporalio: {
          access: '$all',
          publish: '$all',
          unpublish: '$all',
        },
      },

      server: {
        keepAliveTimeout: 60,
      },

      max_body_size: '200mb',
    });

    await new Promise((resolve, reject) => {
      try {
        app.listen(4873, resolve);
        app.on('error', reject);
      } catch (e) {
        reject(e);
      }
    });

    return new this(app, workdir);
  }

  async destroy() {
    return this.app.close();
  }
}

async function withRegistry(testDir, fn) {
  console.log('Starting local registry');
  const registry = await Registry.create(testDir);
  try {
    console.log('Local registry ready');
    return await fn();
  } finally {
    try {
      await registry.destroy();
    } catch (e) {
      console.warn('Warning, failed destroying registry', e);
    }
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
      '--target-dir': String,
    },
    { permissive: true }
  );
  const registryDir = opts['--registry-dir'] ?? (await createTempRegistryDir());
  const targetDir = opts['--target-dir'] ?? path.join(registryDir, 'example');
  return { registryDir, targetDir, initArgs: opts._.length > 0 ? opts._ : [] };
}

module.exports = { getArgs, withRegistry };
