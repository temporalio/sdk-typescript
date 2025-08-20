/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import { ExecutionContext, TestFn } from 'ava';
import { defaultFailureConverter, defaultPayloadConverter, LoadedDataConverter } from '@temporalio/common';
import { WorkerOptions, WorkflowBundle } from '@temporalio/worker';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  configurableHelpers,
  createTestWorkflowEnvironment,
  makeConfigurableEnvironmentTestFn,
} from './helpers-integration';
import { ByteSkewerPayloadCodec, Worker } from './helpers';

// Note: re-export shared workflows (or long workflows)
export * from './workflows';

interface TestConfig {
  loadedDataConverter: LoadedDataConverter;
  env: TestWorkflowEnvironment;
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

          configs.push({
            loadedDataConverter,
            env,
            createWorkerWithDefaults(t: ExecutionContext<TestContext>, opts?: Partial<WorkerOptions>): Promise<Worker> {
              return configurableHelpers(t, t.context.workflowBundle, env).createWorker({
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
