import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
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

function cacheDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function cachePath(key: string): string {
  return path.join(cacheDirectory!, `workflow-bundle-${cacheDigest(key)}.js`);
}

function cacheLogContext(opts: CachedTestWorkflowBundleOptions, key: string): string {
  return `pid=${process.pid} key=${cacheDigest(key)} workflowsPath=${path.resolve(opts.workflowsPath)}`;
}

async function loadOrCreateBundle(
  opts: CachedTestWorkflowBundleOptions,
  key: string
): Promise<WorkflowBundleWithSourceMap> {
  const context = cacheLogContext(opts, key);
  if (cacheDirectory !== undefined) {
    try {
      const start = performance.now();
      const code = await readFile(cachePath(key), 'utf8');
      console.log(
        `[workflow-bundle-cache] disk hit: ${context} loaded ${code.length} bytes in ${(
          performance.now() - start
        ).toFixed(1)}ms`
      );
      return { code, sourceMap: 'deprecated: this is no longer in use\n' };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    console.log(`[workflow-bundle-cache] disk miss: ${context}`);
  } else {
    console.log(`[workflow-bundle-cache] disabled: ${context} TEMPORAL_WORKFLOW_BUNDLE_CACHE_DIR is not set`);
  }

  const bundleStart = performance.now();
  const bundle = await createTestWorkflowBundle({
    workflowsPath: opts.workflowsPath,
    workflowInterceptorModules: opts.workflowInterceptorModules,
    additionalIgnoreModules: testWorkflowBundleIgnoreModules,
  });
  console.log(
    `[workflow-bundle-cache] bundled: ${context} ${bundle.code.length} bytes in ${(
      performance.now() - bundleStart
    ).toFixed(1)}ms`
  );
  if (cacheDirectory !== undefined) {
    const writeStart = performance.now();
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(cachePath(key), bundle.code);
    console.log(
      `[workflow-bundle-cache] wrote: ${context} to disk in ${(performance.now() - writeStart).toFixed(1)}ms`
    );
  }
  return bundle;
}

/** Build the package's default test bundle once per configuration and AVA test run. */
export function getCachedTestWorkflowBundle(
  opts: CachedTestWorkflowBundleOptions
): Promise<WorkflowBundleWithSourceMap> {
  const key = cacheKey(opts);
  const cached = workflowBundles.get(key);
  if (cached !== undefined) {
    console.log(`[workflow-bundle-cache] memory hit: ${cacheLogContext(opts, key)}`);
    return cached;
  }

  const bundle = loadOrCreateBundle(opts, key);
  workflowBundles.set(key, bundle);
  void bundle.catch(() => workflowBundles.delete(key));
  return bundle;
}
