import type { LocalTestWorkflowEnvironmentOptions } from '@temporalio/testing';
import { workflowInterceptorModules as defaultWorkflowInterceptorModules } from '@temporalio/testing';
import type { BundlerPlugin, WorkflowBundleWithSourceMap, BundleOptions } from '@temporalio/worker';
import { bundleWorkflowCode, DefaultLogger } from '@temporalio/worker';
import { defineSearchAttributeKey, SearchAttributeType } from '@temporalio/common/lib/search-attributes';
import { TestWorkflowEnvironment } from './wrappers';
import { baseBundlerIgnoreModules } from './bundler';

export const defaultDynamicConfigOptions = [
  'system.enableActivityEagerExecution=true',
  'history.enableRequestIdRefLinks=true',
  'frontend.activityAPIsEnabled=true',
  'activity.enableStandalone=true',
  'history.enableChasm=true',
  'history.enableTransitionHistory=true',
  'history.enableSignalWithStartFromWorkflow=true',
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
 * Create a test workflow environment, using an existing server if TEMPORAL_SERVICE_ADDRESS is set,
 * otherwise creating a local one.
 */
export async function createTestWorkflowEnvironment(
  opts?: LocalTestWorkflowEnvironmentOptions
): Promise<TestWorkflowEnvironment> {
  let env: TestWorkflowEnvironment;
  if (process.env.TEMPORAL_SERVICE_ADDRESS) {
    env = await TestWorkflowEnvironment.createFromExistingServer({
      address: process.env.TEMPORAL_SERVICE_ADDRESS,
    });
  } else {
    env = await createLocalTestEnvironment(opts);
  }
  return env;
}
