import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DataConverter } from '@temporalio/common';
import type { BundleOptions, WorkerOptions, WorkflowBundlePath } from '@temporalio/worker';
import type { WorkflowBundleWithSourceMapAndFilename } from '@temporalio/worker/lib/workflow/workflow-worker-thread/input';
import { baseBundlerIgnoreModules } from '@temporalio/test-helpers/lib/bundler';

const defaultWorkflowInterceptorModules = [require.resolve('@temporalio/testing/lib/assert-to-failure-interceptor')];
const loadModule = createRequire(__filename);

export const workflowBundleCacheDirectory = path.join(__dirname, 'workflow-bundle-cache');

export type CacheableBundleOptions = Pick<
  BundleOptions,
  | 'workflowsPath'
  | 'workflowInterceptorModules'
  | 'payloadConverterPath'
  | 'failureConverterPath'
  | 'ignoreModules'
  | 'preloadModules'
>;

export interface TestWorkflowBundleOptions {
  workflowsPath: string;
  workflowInterceptorModules?: string[];
  payloadConverterPath?: string;
}

function unique(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  return [...new Set(values)];
}

function resolveModulePath(modulePath: string): string {
  if (!path.isAbsolute(modulePath)) return modulePath;
  try {
    return require.resolve(modulePath);
  } catch {
    return path.resolve(modulePath);
  }
}

export function normalizeBundleOptions(options: CacheableBundleOptions): CacheableBundleOptions {
  return {
    workflowsPath: path.resolve(options.workflowsPath),
    workflowInterceptorModules: unique(options.workflowInterceptorModules?.map(resolveModulePath)),
    payloadConverterPath: options.payloadConverterPath && resolveModulePath(options.payloadConverterPath),
    failureConverterPath: options.failureConverterPath && resolveModulePath(options.failureConverterPath),
    ignoreModules: unique(options.ignoreModules),
    preloadModules: unique(options.preloadModules?.map(resolveModulePath)),
  };
}

function cacheKey(options: CacheableBundleOptions): string {
  return JSON.stringify(normalizeBundleOptions(options));
}

export function workflowBundleCacheFilename(options: CacheableBundleOptions): string {
  const normalized = normalizeBundleOptions(options);
  const basename = path
    .basename(normalized.workflowsPath)
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/gi, '');
  const digest = createHash('sha256').update(cacheKey(normalized)).digest('hex').slice(0, 12);
  return `workflow-bundle-${basename}${digest}.js`;
}

export function workflowBundleCachePath(options: CacheableBundleOptions): string {
  return path.join(workflowBundleCacheDirectory, workflowBundleCacheFilename(options));
}

function missingBundleError(options: CacheableBundleOptions, codePath: string): Error {
  const relativeWorkflowPath = path.relative(__dirname, path.resolve(options.workflowsPath));
  return new Error(
    [
      `No prebuilt test Workflow bundle exists for ${relativeWorkflowPath}.`,
      `Expected cache file: ${codePath}`,
      'Run `pnpm --filter @temporalio/test build` to rebuild the test Workflow bundle cache.',
    ].join('\n')
  );
}

/** Return a cached bundle path. Normal test execution never invokes webpack. */
export function getCachedWorkflowBundle(options: CacheableBundleOptions): WorkflowBundlePath {
  const normalized = normalizeBundleOptions(options);
  const codePath = workflowBundleCachePath(normalized);
  if (!existsSync(codePath)) throw missingBundleError(normalized, codePath);
  return { codePath };
}

/** Load and parse a cached bundle for tests that exercise the Workflow VM directly. */
export function getCachedWorkflowCode(options: CacheableBundleOptions): WorkflowBundleWithSourceMapAndFilename {
  const { codePath } = getCachedWorkflowBundle(options);
  // Parsing is only needed by tests that execute a bundle. Loading Worker here
  // eagerly would make the build-time bundle catalog require the native bridge.
  const { parseWorkflowCode } = loadModule(
    '@temporalio/worker/lib/worker'
  ) as typeof import('@temporalio/worker/lib/worker');
  return parseWorkflowCode(readFileSync(codePath, 'utf8'), codePath);
}

const packageIgnoreModules = [
  ...baseBundlerIgnoreModules,
  require.resolve('./activities'),
  require.resolve('./mock-native-worker'),
  require.resolve('./workflow-bundle-cache'),
];

/** Match the package-specific defaults historically used by createTestWorkflowBundle. */
export function testWorkflowBundleOptions(options: TestWorkflowBundleOptions): CacheableBundleOptions {
  return normalizeBundleOptions({
    ...options,
    workflowInterceptorModules: [...defaultWorkflowInterceptorModules, ...(options.workflowInterceptorModules ?? [])],
    ignoreModules: packageIgnoreModules,
  });
}

export function getCachedTestWorkflowBundle(options: TestWorkflowBundleOptions): WorkflowBundlePath {
  return getCachedWorkflowBundle(testWorkflowBundleOptions(options));
}

function converterBundleOptions(
  dataConverter: DataConverter | undefined
): Pick<CacheableBundleOptions, 'payloadConverterPath' | 'failureConverterPath'> {
  return {
    payloadConverterPath: dataConverter?.payloadConverterPath,
    failureConverterPath: dataConverter?.failureConverterPath,
  };
}

/**
 * Replace a normal Worker's workflowsPath with the corresponding prebuilt bundle.
 * Options that intentionally customize webpack stay exclusive to bundler-focused tests.
 */
export function useCachedWorkflowBundle(options: WorkerOptions): WorkerOptions {
  if (options.workflowsPath === undefined || options.workflowBundle !== undefined) return options;
  if (options.bundlerOptions?.webpackConfigHook !== undefined || (options.plugins?.length ?? 0) > 0) {
    throw new Error(
      'Test Workers that customize webpack or bundler plugins must use the real @temporalio/worker Worker explicitly.'
    );
  }

  const workflowBundle = getCachedWorkflowBundle({
    workflowsPath: options.workflowsPath,
    workflowInterceptorModules: options.interceptors?.workflowModules,
    ...converterBundleOptions(options.dataConverter),
    ignoreModules: options.bundlerOptions?.ignoreModules,
    preloadModules: options.bundlerOptions?.preloadModules,
  });

  return {
    ...options,
    workflowsPath: undefined,
    workflowBundle,
    bundlerOptions: undefined,
    interceptors: options.interceptors && { ...options.interceptors, workflowModules: undefined },
  };
}

function testFile(name: string): string {
  return path.join(__dirname, name);
}

function workflow(name = ''): string {
  return path.join(__dirname, 'workflows', name);
}

const selfWithInterceptor = [
  'test-integration-activities.js',
  'test-integration-cancellation-scopes.js',
  'test-integration-replay-and-flags.js',
  'test-integration-reserved-prefixes.js',
  'test-integration-update-interceptors.js',
  'test-integration-workflow-info.js',
  'test-integration-workflow-start.js',
  'test-isolation.js',
  'test-local-activities.js',
  'test-metrics-custom.js',
  'test-nexus-codec-converter-errors.cloud-unavailable.js',
];

const selfWithoutInterceptor = [
  'test-event-groups.cloud-pending.js',
  'test-integration-custom-search-attributes.cloud-pending.js',
  'test-integration-extstore-nexus.cloud-unavailable.js',
  'test-integration-split-one.cloud-pending.js',
  'test-integration-split-two.cloud-pending.js',
  'test-integration-update.js',
  'test-integration-workflows-with-recorded-logs.js',
  'test-nexus-operation-timeouts.cloud-unavailable.js',
  'test-nexus-query-operation.cloud-unavailable.js',
  'test-nexus-signal-linking.cloud-unavailable.js',
  'test-nexus-standalone.cloud-unavailable.js',
  'test-nexus-temporal-operation.cloud-unavailable.js',
  'test-nexus-update-operation.cloud-unavailable.js',
  'test-typed-search-attributes.cloud-unavailable.js',
  'test-worker-connection-replacement.local.js',
  'test-worker-deployment-versioning.js',
  'test-worker-tuner.js',
  'test-workflow-cancellation.js',
  'test-workflow-fail-on-errors-policy.js',
  'test-workflow-nexus-cancellation.cloud-unavailable.js',
];

const rawWorkflowEntries = [
  '',
  'index.js',
  'default-workflow-function.js',
  'echo-binary-protobuf.js',
  'patch-and-condition-pre-patch.js',
  'patch-and-condition-post-patch.js',
  'protobufs.js',
  'signal-query-patch-pre-patch.js',
  'signal-query-patch-post-patch.js',
];

/** Complete, audited list of bundles consumed by the primary test suite. */
export function getTestWorkflowBundleCatalog(): CacheableBundleOptions[] {
  const testBundles: TestWorkflowBundleOptions[] = [
    ...selfWithInterceptor.map((name) => ({
      workflowsPath: testFile(name),
      workflowInterceptorModules: [testFile(name)],
    })),
    ...selfWithoutInterceptor.map((name) => ({ workflowsPath: testFile(name) })),
    { workflowsPath: workflow() },
    { workflowsPath: workflow('index.js') },
    { workflowsPath: testFile('integration-workflows-common.js') },
    { workflowsPath: workflow('default-activity-wf.js') },
    { workflowsPath: workflow('local-activities.js') },
    { workflowsPath: workflow('nested-promise.js') },
    { workflowsPath: workflow('patch-activation-callback-new.js') },
    { workflowsPath: workflow('patch-activation-callback-old.js') },
    { workflowsPath: workflow('random-streams.js') },
    { workflowsPath: workflow('runtime.js') },
    {
      workflowsPath: workflow('type-info/index.js'),
      workflowInterceptorModules: [...defaultWorkflowInterceptorModules, workflow('type-info/interceptors.js')],
    },
    {
      workflowsPath: testFile('test-nexus-workflow-caller.cloud-unavailable.js'),
      workflowInterceptorModules: [workflow('type-info/nexus-interceptors.js')],
    },
    {
      workflowsPath: testFile('test-workflow-async-local-storage.js'),
      workflowInterceptorModules: [workflow('otel-interceptors.js')],
    },
    {
      workflowsPath: testFile('test-event-groups.cloud-pending.js'),
      payloadConverterPath: testFile('payload-converters/string-mangling-payload-converter.js'),
    },
  ];

  const rawBundles: CacheableBundleOptions[] = rawWorkflowEntries.map((name) => ({ workflowsPath: workflow(name) }));
  rawBundles.push(
    { workflowsPath: testFile('deployment-versioning-v1/index.js') },
    { workflowsPath: testFile('deployment-versioning-v2/index.js') },
    { workflowsPath: testFile('deployment-versioning-v3/index.js') },
    { workflowsPath: testFile('deployment-versioning-no-annotations/index.js') },
    { workflowsPath: testFile('deployment-versioning-can-v1/index.js') },
    { workflowsPath: testFile('deployment-versioning-can-v2/index.js') },
    ...['', 'index.js'].flatMap((workflowsEntry) => [
      {
        workflowsPath: workflow(workflowsEntry),
        workflowInterceptorModules: [workflow('interceptor-example.js')],
      },
      {
        workflowsPath: workflow(workflowsEntry),
        workflowInterceptorModules: [workflow('internals-interceptor-example.js')],
      },
      {
        workflowsPath: workflow(workflowsEntry),
        workflowInterceptorModules: [workflow('internal-interceptor-dispose-global.js')],
      },
    ]),
    {
      workflowsPath: workflow('protobufs.js'),
      payloadConverterPath: testFile('payload-converters/proto-payload-converter.js'),
    },
    {
      workflowsPath: workflow('echo-binary-protobuf.js'),
      payloadConverterPath: testFile('payload-converters/proto-payload-converter.js'),
    },
    {
      workflowsPath: testFile('test-failure-converter.js'),
      failureConverterPath: testFile('test-failure-converter.js'),
      ignoreModules: packageIgnoreModules,
    },
    {
      workflowsPath: workflow('serialization-context.js'),
      workflowInterceptorModules: [...defaultWorkflowInterceptorModules],
      ignoreModules: packageIgnoreModules,
    },
    {
      workflowsPath: workflow('serialization-context.js'),
      workflowInterceptorModules: [...defaultWorkflowInterceptorModules],
      payloadConverterPath: testFile('payload-converters/serialization-context-converter.js'),
      failureConverterPath: testFile('payload-converters/serialization-context-converter.js'),
      ignoreModules: packageIgnoreModules,
    },
    {
      workflowsPath: workflow('testenv-test-workflows.js'),
      workflowInterceptorModules: [...defaultWorkflowInterceptorModules],
    },
    {
      workflowsPath: workflow(),
      workflowInterceptorModules: [workflow('random-stream-interceptors.js')],
    }
  );

  const uniqueCatalog = new Map<string, CacheableBundleOptions>();
  for (const options of [...testBundles.map(testWorkflowBundleOptions), ...rawBundles]) {
    const normalized = normalizeBundleOptions(options);
    uniqueCatalog.set(cacheKey(normalized), normalized);
  }
  return [...uniqueCatalog.values()];
}
