import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowBundle } from '@temporalio/worker';
import { workflowInterceptorModules as defaultWorkflowInterceptorModules } from '@temporalio/testing';
import { createTestWorkflowBundle } from '@temporalio/test-helpers/lib/environment';

export const workflowBundleCacheDirectory = path.join(__dirname, 'workflow-bundle-cache');

const bundleConfigurationPaths = [
  require.resolve('@temporalio/test-helpers/lib/environment'),
  require.resolve('@temporalio/test-helpers/lib/bundler'),
  require.resolve('@temporalio/worker/lib/workflow/bundler'),
];

export interface CachedTestWorkflowBundleOptions {
  workflowsPath: string;
  workflowInterceptorModules?: string[];
}

function resolveModulePath(modulePath: string): string {
  try {
    return require.resolve(modulePath);
  } catch {
    return path.resolve(modulePath);
  }
}

function normalizeOptions(opts: CachedTestWorkflowBundleOptions): Required<CachedTestWorkflowBundleOptions> {
  return {
    workflowsPath: path.resolve(opts.workflowsPath),
    workflowInterceptorModules: [...defaultWorkflowInterceptorModules, ...(opts.workflowInterceptorModules ?? [])].map(
      resolveModulePath
    ),
  };
}

function cachePath(opts: Required<CachedTestWorkflowBundleOptions>): string {
  const digest = createHash('sha256').update(JSON.stringify(opts)).digest('hex').slice(0, 12);
  return path.join(workflowBundleCacheDirectory, `workflow-bundle-${digest}.js`);
}

async function newestInputMtime(inputPath: string): Promise<number> {
  const inputStat = await stat(inputPath);
  if (!inputStat.isDirectory()) return inputStat.mtimeMs;

  const entries = await readdir(inputPath, { withFileTypes: true });
  const mtimes = await Promise.all(entries.map((entry) => newestInputMtime(path.join(inputPath, entry.name))));
  return Math.max(inputStat.mtimeMs, ...mtimes);
}

/** JIT-build and cache the package's default test bundle for a workflow configuration. */
export async function getCachedTestWorkflowBundle(opts: CachedTestWorkflowBundleOptions): Promise<WorkflowBundle> {
  const normalized = normalizeOptions(opts);
  const codePath = cachePath(normalized);
  try {
    const [cacheStats, newestMtime] = await Promise.all([
      stat(codePath),
      Promise.all([
        ...bundleConfigurationPaths,
        normalized.workflowsPath,
        ...normalized.workflowInterceptorModules,
      ]).then((inputPaths) => Promise.all(inputPaths.map(newestInputMtime))),
    ]);
    if (cacheStats.mtimeMs >= Math.max(...newestMtime)) {
      return { code: await readFile(codePath, 'utf8') };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const { code } = await createTestWorkflowBundle({
    workflowsPath: normalized.workflowsPath,
    workflowInterceptorModules: opts.workflowInterceptorModules,
    additionalIgnoreModules: [
      require.resolve('./activities'),
      require.resolve('./mock-native-worker'),
      require.resolve('./workflow-bundle-cache'),
    ],
  });
  await mkdir(workflowBundleCacheDirectory, { recursive: true });
  await writeFile(codePath, code);
  return { code };
}
