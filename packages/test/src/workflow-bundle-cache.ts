import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { workflowInterceptorModules as defaultWorkflowInterceptorModules } from '@temporalio/testing';
import { createTestWorkflowBundle } from '@temporalio/test-helpers/lib/environment';

export const testWorkflowBundleIgnoreModules = [
  require.resolve('./activities'),
  require.resolve('./mock-native-worker'),
  require.resolve('./workflow-bundle-cache'),
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

function cacheKey(opts: CachedTestWorkflowBundleOptions): string {
  return JSON.stringify({
    workflowsPath: path.resolve(opts.workflowsPath),
    workflowInterceptorModules: [...defaultWorkflowInterceptorModules, ...(opts.workflowInterceptorModules ?? [])].map(
      resolveModulePath
    ),
  });
}

const workflowBundles = new Map<string, Promise<WorkflowBundleWithSourceMap>>();
const cacheDirectory = process.env.TEMPORAL_WORKFLOW_BUNDLE_CACHE_DIR;

function cachePath(key: string): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 12);
  return path.join(cacheDirectory!, `workflow-bundle-${digest}.js`);
}

async function loadOrCreateBundle(
  opts: CachedTestWorkflowBundleOptions,
  key: string
): Promise<WorkflowBundleWithSourceMap> {
  if (cacheDirectory !== undefined) {
    try {
      return { code: await readFile(cachePath(key), 'utf8'), sourceMap: 'deprecated: this is no longer in use\n' };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  const bundle = await createTestWorkflowBundle({
    workflowsPath: opts.workflowsPath,
    workflowInterceptorModules: opts.workflowInterceptorModules,
    additionalIgnoreModules: testWorkflowBundleIgnoreModules,
  });
  if (cacheDirectory !== undefined) {
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(cachePath(key), bundle.code);
  }
  return bundle;
}

/** Build the package's default test bundle once per configuration and AVA test run. */
export function getCachedTestWorkflowBundle(
  opts: CachedTestWorkflowBundleOptions
): Promise<WorkflowBundleWithSourceMap> {
  const key = cacheKey(opts);
  const cached = workflowBundles.get(key);
  if (cached !== undefined) return cached;

  const bundle = loadOrCreateBundle(opts, key);
  workflowBundles.set(key, bundle);
  void bundle.catch(() => workflowBundles.delete(key));
  return bundle;
}
