import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runServer } from 'verdaccio';

const port = 4873;

interface VerdaccioServer {
  listen: (port: number, callback: () => void) => void;
  on: (event: string, listener: (...args: any[]) => void) => void;
  close: () => void;
}

async function startRegistry(registryDir: string): Promise<VerdaccioServer> {
  mkdirSync(registryDir, { recursive: true });

  const app = await runServer({
    self_path: registryDir,
    storage: resolve(registryDir, 'storage'),

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

    // As of November 2026, the @temporalio/core-bridge tarball in debug mode
    // (i.e. part of the on-pull-request GHA workflow) is ~214MB compressed.
    max_body_size: '1gb',
  });

  await new Promise<void>((resolve, reject) => {
    try {
      app.listen(port, resolve);
      app.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });

  return app;
}

export interface RegistryConfig {
  /** An `.npmrc` file that points npm at the registry. */
  file: string;
  /** The contents of `file`. */
  contents: string;
}

/**
 * Runs `fn` with a local Verdaccio registry serving the `@temporalio/*` packages from `registryDir`.
 *
 * The registry runs in this process, so `fn` must not block the event loop.
 */
export async function withRegistry<T>(registryDir: string, fn: (config: RegistryConfig) => Promise<T>): Promise<T> {
  console.log('Starting local registry');
  const app = await startRegistry(registryDir);

  const lines = [
    `@temporalio:registry=http://localhost:${port}`,
    `//localhost:${port}/:_authToken=anon`,
    // The packages under test were just published, so a `min-release-age` policy would reject them.
    'min-release-age-exclude[]=@temporalio/*',
  ];
  if (!process.env.CI) {
    // When testing on dev's local machine, uses an isolated NPM cache directory to avoid mixing
    // existing @temporalio/* cached packages with the ones from the local registry. We don't do
    // that in CI though, as it is not needed (i.e. there should be no such cached packages yet)
    // and would slow down the tests (i.e. it requires redownloading ALL packages).
    lines.push(`cache=${resolve(registryDir, 'npm-cache')}`);
  }
  const contents = lines.join('\n') + '\n';
  const file = resolve(registryDir, '.npmrc');
  writeFileSync(file, contents, { encoding: 'utf-8' });

  try {
    console.log('Local registry ready');
    return await fn({ file, contents });
  } finally {
    try {
      app.close();
    } catch (e) {
      console.warn('Warning, failed destroying registry', e);
    }
  }
}
