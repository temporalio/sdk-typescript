import path, { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
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

/**
 * Run a function with a local Verdaccio registry.
 *
 * @param registryDir - directory to create the registry in (e.g. a temp directory)
 * @param workdir - root directory of the project that will be using the registry
 *                  (e.g. the root directory of the SDK mono repo when publishing
 *                  packages to the registry, or the directory where `pnpm install`
 *                  will be run when installing from the registry).
 * @param fn - function to run with the registry
 * @returns the result of the function
 */
export async function withRegistry(
  registryDir: string, // directory to create the registry in (e.g. a temp directory)
  workdir: string, // root directory of the project that will be using the registry (e.g. the root )
  fn: (configFile: string) => Promise<void>
): Promise<void> {
  console.log('Starting local registry');
  const registry = await Registry.create(registryDir);

  const npmConfigFile = resolve(workdir, '.npmrc');
  let npmConfig = `@temporalio:registry=http://localhost:4873`;
  npmConfig += `\n//localhost:4873/:_authToken=anon`;
  if (!process.env?.['CI']) {
    // When testing on dev's local machine, uses an isolated NPM cache directory to avoid mixing
    // existing @temporalio/* cached packages with the ones from the local registry. We don't do
    // that in CI though, as it is not needed (i.e. there should be no such cached packages yet)
    // and would slow down the tests (i.e. it requires redownloading ALL packages).
    npmConfig += `\ncache=${resolve(registryDir, 'npm-cache')}`;
  }

  try {
    writeFileSync(npmConfigFile, npmConfig, { encoding: 'utf-8' });

    console.log('Local registry ready');
    return await fn(npmConfigFile);
  } finally {
    try {
      unlinkSync(npmConfigFile);
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
