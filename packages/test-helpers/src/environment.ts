import type { LocalTestWorkflowEnvironmentOptions } from '@temporalio/testing';
import { workflowInterceptorModules as defaultWorkflowInterceptorModules } from '@temporalio/testing';
import { loadClientConnectConfig, type LoadClientProfileOptions } from '@temporalio/envconfig';
import type { BundlerPlugin, WorkflowBundleWithSourceMap, BundleOptions } from '@temporalio/worker';
import { bundleWorkflowCode, DefaultLogger } from '@temporalio/worker';
import { defineSearchAttributeKey, SearchAttributeType } from '@temporalio/common/lib/search-attributes';
import { TestWorkflowEnvironment } from './wrappers';
import { baseBundlerIgnoreModules } from './bundler';
import { isSet } from './flags';

export const defaultDynamicConfigOptions = [
  'system.enableActivityEagerExecution=true',
  'history.enableRequestIdRefLinks=true',
  'frontend.activityAPIsEnabled=true',
  'activity.enableStandalone=true',
  'history.enableChasm=true',
  'history.enableTransitionHistory=true',
];

export const defaultSAKeys = {
  CustomIntField: defineSearchAttributeKey('CustomIntField', SearchAttributeType.INT),
  CustomBoolField: defineSearchAttributeKey('CustomBoolField', SearchAttributeType.BOOL),
  CustomKeywordField: defineSearchAttributeKey('CustomKeywordField', SearchAttributeType.KEYWORD),
  CustomTextField: defineSearchAttributeKey('CustomTextField', SearchAttributeType.TEXT),
  CustomDatetimeField: defineSearchAttributeKey('CustomDatetimeField', SearchAttributeType.DATETIME),
  CustomDoubleField: defineSearchAttributeKey('CustomDoubleField', SearchAttributeType.DOUBLE),
};

/**
 * Options for creating test workflow bundles.
 */
export interface TestWorkflowBundleOptions {
  workflowsPath: string;
  workflowInterceptorModules?: string[];
  additionalIgnoreModules?: string[];
  plugins?: BundlerPlugin[];
}

/**
 * Create a test workflow bundle with standard configuration.
 */
export async function createTestWorkflowBundle({
  workflowsPath,
  workflowInterceptorModules,
  additionalIgnoreModules = [],
  plugins,
}: TestWorkflowBundleOptions): Promise<WorkflowBundleWithSourceMap> {
  const bundlerOptions: Partial<BundleOptions> = {
    ignoreModules: [...baseBundlerIgnoreModules, ...additionalIgnoreModules],
  };

  return await bundleWorkflowCode({
    ...bundlerOptions,
    workflowInterceptorModules: [...defaultWorkflowInterceptorModules, ...(workflowInterceptorModules ?? [])],
    workflowsPath,
    logger: new DefaultLogger('WARN'),
    plugins: plugins ?? [],
  });
}

/**
 * Create a local test environment with default search attributes and dynamic config.
 */
export async function createLocalTestEnvironment(
  opts?: LocalTestWorkflowEnvironmentOptions
): Promise<TestWorkflowEnvironment> {
  return await TestWorkflowEnvironment.createLocal({
    ...(opts || {}),
    server: {
      searchAttributes: Object.values(defaultSAKeys),
      ...(opts?.server || {}),
      extraArgs: [
        ...defaultDynamicConfigOptions.flatMap((opt) => ['--dynamic-config-value', opt]),
        ...(opts?.server?.extraArgs ?? []),
      ],
    },
  });
}

/**
 * Create a test workflow environment.
 *
 * Uses envconfig for the test server connection when TEMPORAL_TEST_ENV_CONFIG_SERVER is truthy, uses
 * TEMPORAL_SERVICE_ADDRESS as a legacy existing-server shortcut when set, otherwise creates a local environment.
 */
export async function createTestWorkflowEnvironment(
  opts?: LocalTestWorkflowEnvironmentOptions,
  envconfigOpts?: LoadClientProfileOptions
): Promise<TestWorkflowEnvironment> {
  if (isSet(process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER, false)) {
    const { namespace, connectionOptions } = loadClientConnectConfig(envconfigOpts);
    const { address, apiKey, metadata, tls } = connectionOptions;
    return await TestWorkflowEnvironment.createFromExistingServer({
      address,
      namespace,
      connectionOptions: { apiKey, metadata, tls },
      client: opts?.client,
      plugins: opts?.plugins,
    });
  }
  if (process.env.TEMPORAL_SERVICE_ADDRESS) {
    return await TestWorkflowEnvironment.createFromExistingServer({
      address: process.env.TEMPORAL_SERVICE_ADDRESS,
      plugins: opts?.plugins,
    });
  }
  return await createLocalTestEnvironment(opts);
}
