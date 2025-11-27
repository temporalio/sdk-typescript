import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { mkdtemp } from 'fs-extra';
import arg from 'arg';
import { runServer } from 'verdaccio';

interface VerdaccioServer {
  listen: (port: number, callback: () => void) => void;
  on: (event: string, listener: (...args: any[]) => void) => void;
  close: () => Promise<void>;
}

class Registry {
  constructor(
    public readonly app: VerdaccioServer,
    public readonly workdir: string
  ) {}

  static async create(workdir: string): Promise<Registry> {
    mkdirSync(workdir, { recursive: true });

    const app = (await runServer({
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
    })) as unknown as VerdaccioServer;

    await new Promise<void>((resolve, reject) => {
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

export async function withRegistry(testDir: string, fn: () => Promise<void>): Promise<void> {
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
export async function getArgs(): Promise<{ registryDir: string; targetDir: string; initArgs: string[] }> {
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
