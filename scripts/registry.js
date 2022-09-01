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

      // ...config,
      storage: path.resolve(workdir, 'storage'),

      web: {
        title: 'Verdaccio',
      },

      auth: {
        htpasswd: {
          file: path.resolve(workdir, 'htpasswd'),
        },
      },

      uplinks: {
        npmjs: {
          url: 'https://registry.npmjs.org/',
        },
      },

      packages: {
        // Note that the Temporal packages don't proxy npmjs to ensure we test the correct packages
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
        '@*/*': {
          access: '$all',
          publish: '$all',
          unpublish: '$all',
          proxy: 'npmjs',
        },
        '**': {
          access: '$all',
          publish: '$all',
          unpublish: '$all',
          proxy: 'npmjs',
        },
      },

      server: {
        keepAliveTimeout: 60,
      },
      // We have some really large packages (e.g. worker)
      max_body_size: '200mb',

      logs: {
        type: 'file',
        format: 'pretty',
        path: path.resolve(workdir, 'verdaccio.log'),
        level: 'http',
      },
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
    },
    { permissive: true }
  );
  const registryDir = opts['--registry-dir'] || (await createTempRegistryDir());
  return { registryDir, initArgs: opts._.length > 0 ? opts._ : [] };
}

module.exports = { getArgs, withRegistry };
