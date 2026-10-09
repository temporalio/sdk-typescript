/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import type { ExecutionContext, TestFn } from 'ava';
import type { LoadedDataConverter } from '@temporalio/common';
import { defaultFailureConverter, defaultPayloadConverter } from '@temporalio/common';
import type { WorkerOptions, WorkflowBundle } from '@temporalio/worker';

import type { TestWorkflowEnvironment } from '@temporalio/testing';
import type { BaseHelpers } from '@temporalio/test-helpers';
import {
  configurableHelpers,
  createTestWorkflowEnvironment,
  makeConfigurableEnvironmentTestFn,
} from './helpers-integration';
import type { Worker } from './helpers';
import { ByteSkewerPayloadCodec } from './helpers';

// Note: re-export shared workflows (or long workflows)
export * from './workflows';

interface TestConfig {
  loadedDataConverter: LoadedDataConverter;
  env: TestWorkflowEnvironment;
  /** Helpers bound to this variant's environment and task queue. */
  helpers: (t: ExecutionContext<TestContext>) => BaseHelpers;
  createWorkerWithDefaults: (t: ExecutionContext<TestContext>, opts?: Partial<WorkerOptions>) => Promise<Worker>;
}
interface TestContext {
  workflowBundle: WorkflowBundle;
  configs: TestConfig[];
}

const codecs = [undefined, new ByteSkewerPayloadCodec()];

export function makeTestFn(makeBundle: () => Promise<WorkflowBundle>): TestFn<TestContext> {
  return makeConfigurableEnvironmentTestFn<TestContext>({
    createTestContext: async (_t: ExecutionContext) => {
      const configs: TestConfig[] = [];
      await Promise.all(
        codecs.map(async (codec) => {
          const dataConverter = { payloadCodecs: codec ? [codec] : [] };
          const loadedDataConverter = {
            payloadConverter: defaultPayloadConverter,
            payloadCodecs: codec ? [codec] : [],
            failureConverter: defaultFailureConverter,
          };

          const env = await createTestWorkflowEnvironment({
            client: { dataConverter },
          });
          // Variants run concurrently and may share a namespace (e.g. on Cloud), so each needs its own task queue.
          const taskQueueSuffix = codec ? 'byte-skewer' : undefined;
          const helpers = (t: ExecutionContext<TestContext>) =>
            configurableHelpers(t, t.context.workflowBundle, env, taskQueueSuffix);

          configs.push({
            loadedDataConverter,
            env,
            helpers,
            createWorkerWithDefaults(t: ExecutionContext<TestContext>, opts?: Partial<WorkerOptions>): Promise<Worker> {
              return helpers(t).createWorker({
                dataConverter,
                ...opts,
              });
            },
          });
        })
      );
      return {
        workflowBundle: await makeBundle(),
        configs,
      };
    },
    teardown: async (testContext: TestContext) => {
      for (const config of testContext.configs) {
        await config.env.teardown();
      }
    },
  });
}

export const configMacro = async (
  t: ExecutionContext<TestContext>,
  testFn: (t: ExecutionContext<TestContext>, config: TestConfig) => Promise<unknown> | unknown
): Promise<void> => {
  const testPromises = t.context.configs.map(async (config) => {
    // Note: ideally, we'd like to add an annotation to the test name to indicate what codec it used
    await testFn(t, config);
  });
  await Promise.all(testPromises);
};
