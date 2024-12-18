/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import { ExecutionContext, TestFn } from 'ava';
import {
  defaultFailureConverter,
  defaultPayloadConverter,
  LoadedDataConverter,
} from '@temporalio/common';
import { WorkerOptions, WorkflowBundle } from '@temporalio/worker';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { ConnectionInjectorInterceptor } from './activities/interceptors';
import {
  configurableHelpers,
  createLocalTestEnvironment,
  createTestWorkflowBundle,
  HelperTestBundleOptions,
  makeConfigurableEnvironmentTestFn,
} from './helpers-integration';
import {
  ByteSkewerPayloadCodec,
  registerDefaultCustomSearchAttributes,
  Worker,
} from './helpers';

// Note: re-export shared workflows (or long workflows)
//  - review the files where these workflows are shared
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

export function makeTestFn(opts: HelperTestBundleOptions): TestFn<TestContext> {
  return makeConfigurableEnvironmentTestFn<TestContext>({
    createTestContext: async (_t: ExecutionContext) => {
      const workflowBundle = await createTestWorkflowBundle(opts);
      const configs: TestConfig[] = [];
      await Promise.all(
        codecs.map(async (codec) => {
          const dataConverter = { payloadCodecs: codec ? [codec] : [] };
          const loadedDataConverter = {
            payloadConverter: defaultPayloadConverter,
            payloadCodecs: codec ? [codec] : [],
            failureConverter: defaultFailureConverter,
          };
  
          const env = await createLocalTestEnvironment({
            client: { dataConverter },
          });
          await registerDefaultCustomSearchAttributes(env.connection);
  
          configs.push({
            loadedDataConverter,
            env,
            createWorkerWithDefaults(t: ExecutionContext<TestContext>, opts?: Partial<WorkerOptions>): Promise<Worker> {
              return configurableHelpers(t, t.context.workflowBundle, env).createWorker({
                dataConverter,
                interceptors: {
                  activity: [() => ({ inbound: new ConnectionInjectorInterceptor(env.connection, loadedDataConverter) })],
                },
                ...opts,
              });
            },
          });
        })
      );
      return {
        workflowBundle,
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
) => {
  const testPromises = t.context.configs.map(async (config) => {
    // TODO(thomas): ideally, we'd like to add an annotation to the test name to indicate what codec it used
    await testFn(t, config);
  });
  await Promise.all(testPromises);
}

