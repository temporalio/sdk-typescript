/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import { randomUUID } from 'crypto';
import type { ExecutionContext } from 'ava';
import type { DataConverter, LoadedDataConverter } from '@temporalio/common';
import { defaultFailureConverter, defaultPayloadConverter } from '@temporalio/common';
import type { BaseHelpers } from '@temporalio/test-helpers';
import { createBaseHelpers, defaultTaskQueueTransform } from '@temporalio/test-helpers';
import type { WorkerOptions, WorkflowBundle } from '@temporalio/worker';

import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { createTestWorkflowEnvironment, makeConfigurableEnvironmentTestFn } from './helpers-integration';
import { ByteSkewerPayloadCodec } from './helpers';

// Note: re-export shared workflows (or long workflows)
export * from './workflows';

export type DataConverterVariant = 'default' | 'byte-skewer';

interface DataConverterConfig {
  variant: DataConverterVariant;
  dataConverter: DataConverter;
  loadedDataConverter: LoadedDataConverter;
  env: TestWorkflowEnvironment;
}

interface TestContext {
  workflowBundle: WorkflowBundle;
  configs: DataConverterConfig[];
}

export interface DataConverterTestCase {
  readonly variant: DataConverterVariant;
  readonly env: TestWorkflowEnvironment;
  readonly helpers: BaseHelpers;
  readonly loadedDataConverter: LoadedDataConverter;
}

type DataConverterTestImplementation = (
  t: ExecutionContext<TestContext>,
  testCase: DataConverterTestCase
) => Promise<unknown> | unknown;

export interface DataConverterTestFn {
  (title: string, implementation: DataConverterTestImplementation): void;
  serial(title: string, implementation: DataConverterTestImplementation): void;
}

const dataConverterVariants: ReadonlyArray<{ variant: DataConverterVariant; dataConverter: DataConverter }> = [
  { variant: 'default', dataConverter: { payloadCodecs: [] } },
  { variant: 'byte-skewer', dataConverter: { payloadCodecs: [new ByteSkewerPayloadCodec()] } },
];

/**
 * Create an AVA test registrar that runs each declaration once per data converter variant.
 *
 * Each case receives helpers whose Worker factory is bound to the same unique task queue and data converter.
 */
export function makeDataConverterTest(makeBundle: () => Promise<WorkflowBundle>): DataConverterTestFn {
  const avaTest = makeConfigurableEnvironmentTestFn<TestContext>({
    createTestContext: async (_t: ExecutionContext) => {
      const workflowBundle = await makeBundle();
      const configs: DataConverterConfig[] = [];

      try {
        for (const { variant, dataConverter } of dataConverterVariants) {
          const payloadCodecs = dataConverter.payloadCodecs ?? [];
          const loadedDataConverter = {
            payloadConverter: defaultPayloadConverter,
            payloadCodecs,
            failureConverter: defaultFailureConverter,
          };

          const env = await createTestWorkflowEnvironment({
            client: { dataConverter },
          });

          configs.push({
            variant,
            dataConverter,
            loadedDataConverter,
            env,
          });
        }
      } catch (error) {
        await teardownDataConverterConfigs(configs, true);
        throw error;
      }

      return {
        workflowBundle,
        configs,
      };
    },
    teardown: async (testContext: TestContext) => {
      await teardownDataConverterConfigs(testContext.configs);
    },
  });

  const test = ((title, implementation) => {
    declareEachDataConverterTest((caseTitle, exec) => avaTest(caseTitle, exec), title, implementation);
  }) as DataConverterTestFn;

  test.serial = (title, implementation) => {
    declareEachDataConverterTest((caseTitle, exec) => avaTest.serial(caseTitle, exec), title, implementation);
  };

  return test;
}

function declareEachDataConverterTest(
  declareTest: (title: string, implementation: (t: ExecutionContext<TestContext>) => Promise<void>) => void,
  title: string,
  implementation: DataConverterTestImplementation
): void {
  for (const [index, { variant }] of dataConverterVariants.entries()) {
    declareTest(`${title} [${variant}]`, async (t) => {
      const config = t.context.configs[index]!;
      const helpers = createBaseHelpers({
        taskQueue: defaultTaskQueueTransform(`${randomUUID()}-${t.title}`),
        env: config.env,
        workflowBundle: t.context.workflowBundle,
      });
      const codecHelpers: BaseHelpers = {
        ...helpers,
        createWorker: (opts?: Partial<WorkerOptions>) =>
          helpers.createWorker({ ...opts, dataConverter: config.dataConverter }),
      };

      await implementation(t, {
        variant: config.variant,
        env: config.env,
        helpers: codecHelpers,
        loadedDataConverter: config.loadedDataConverter,
      });
    });
  }
}

async function teardownDataConverterConfigs(configs: DataConverterConfig[], suppressErrors = false): Promise<void> {
  const results = await Promise.allSettled(configs.map(({ env }) => env.teardown()));
  if (suppressErrors) return;

  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Failed to tear down data converter test environments');
}
