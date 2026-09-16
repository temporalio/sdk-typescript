/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import type { SearchAttributes } from '@temporalio/common';
import type { InjectedSinks } from '@temporalio/worker';
import pkg from '@temporalio/worker/lib/pkg';
import { workflowInfo } from '@temporalio/workflow';
import { configurableHelpers, createTestWorkflowBundle } from './helpers-integration';
import { configMacro, makeTestFn } from './helpers-integration-multi-codec';
import * as workflows from './workflows';

export * from './workflows';

const test = makeTestFn(() => createTestWorkflowBundle({ workflowsPath: __filename }));
test.macro(configMacro);

test.serial('WorkflowHandle.describe result is wrapped', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const date = new Date();
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.argsAndReturn, {
    args: ['hey', undefined, Buffer.from('abc')],
    searchAttributes: {
      CustomKeywordField: ['test-value'],
      CustomIntField: [1],
      CustomDatetimeField: [date],
    },
    memo: {
      note: 'foo',
    },
  });
  await worker.runUntil(handle.result());
  const execution = await handle.describe();
  t.deepEqual(execution.type, 'argsAndReturn');
  t.deepEqual(execution.memo, { note: 'foo' });
  t.true(execution.startTime instanceof Date);
  t.deepEqual(execution.searchAttributes!.CustomKeywordField, ['test-value']);
  t.deepEqual(execution.searchAttributes!.CustomIntField, [1]);
  t.deepEqual(execution.searchAttributes!.CustomDatetimeField, [date]);
  const binSum = execution.searchAttributes!.BinaryChecksums as string[];
  if (binSum != null) {
    t.regex(binSum[0], /@temporalio\/worker@/);
  } else {
    t.deepEqual(execution.searchAttributes!.BuildIds, ['unversioned', `unversioned:${worker.options.buildId}`]);
  }
});

export async function returnSearchAttributes(): Promise<SearchAttributes | undefined> {
  const sa = workflowInfo().searchAttributes!;
  const datetime = (sa.CustomDatetimeField as Array<Date>)[0];
  return {
    ...sa,
    datetimeType: [Object.getPrototypeOf(datetime).constructor.name],
    datetimeInstanceofWorks: [datetime instanceof Date],
    arrayInstanceofWorks: [sa.CustomIntField instanceof Array],
  };
}

test.serial('Workflow can read Search Attributes set at start', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const date = new Date();
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(returnSearchAttributes, {
    searchAttributes: {
      CustomKeywordField: ['test-value'],
      CustomIntField: [1],
      CustomDatetimeField: [date],
    },
  });
  const res = await worker.runUntil(handle.result());
  t.deepEqual(res, {
    CustomKeywordField: ['test-value'],
    CustomIntField: [1],
    CustomDatetimeField: [date.toISOString()],
    datetimeInstanceofWorks: [true],
    arrayInstanceofWorks: [true],
    datetimeType: ['Date'],
  });
});

test.serial('Workflow can upsert Search Attributes', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const date = new Date();
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t, {
    sinks: {
      customLogger: {
        info: {
          fn: async (_info, _message) => {
            /* we don't need these for this test */
          },
          callDuringReplay: false,
        },
      },
    } satisfies InjectedSinks<workflows.CustomLoggerSinks>,
  });
  const handle = await startWorkflow(workflows.upsertAndReadSearchAttributes, {
    args: [date.getTime()],
  });
  const res = await worker.runUntil(handle.result());
  t.deepEqual(res, {
    CustomBoolField: [true],
    CustomKeywordField: ['durable code'],
    CustomTextField: ['is useful'],
    CustomDatetimeField: [date.toISOString()],
    CustomDoubleField: [3.14],
  });
  const { searchAttributes } = await handle.describe();
  const { BinaryChecksums, BuildIds, ...rest } = searchAttributes;
  t.deepEqual(rest, {
    CustomBoolField: [true],
    CustomKeywordField: ['durable code'],
    CustomTextField: ['is useful'],
    CustomDatetimeField: [date],
    CustomDoubleField: [3.14],
  });
  let checksum: any;
  if (BinaryChecksums != null) {
    t.true(BinaryChecksums.length === 1);
    checksum = BinaryChecksums[0];
  } else {
    t.true(BuildIds!.length === 2);
    t.deepEqual(BuildIds![0], 'unversioned');
    checksum = BuildIds![1];
  }
  t.true(
    typeof checksum === 'string' &&
      checksum.includes(`@temporalio/worker@${pkg.version}+`) &&
      /\+[a-f0-9]{64}$/.test(checksum) // bundle checksum
  );
});
