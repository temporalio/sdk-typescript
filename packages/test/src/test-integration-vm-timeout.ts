import type { TestFn } from 'ava';
import type { DefaultEncodedFailureAttributes } from '@temporalio/common';
import { DefaultFailureConverter, defaultPayloadConverter } from '@temporalio/common';
import type { LogEntry } from '@temporalio/worker';
import { DefaultLogger, Runtime } from '@temporalio/worker';
import type { temporal } from '@temporalio/proto';
import type { Context } from './helpers-integration';
import { createTestWorkflowBundle, createTestWorkflowEnvironment, helpers } from './helpers-integration';
import { test as anyTest, waitUntil, bundlerOptions } from './helpers';

const test = anyTest as TestFn<Context>;
const logs: LogEntry[] = [];
export const failureConverter = new DefaultFailureConverter({ encodeCommonAttributes: true });

export async function vmTimeoutWorkflow(mode: 'timeout' | 'ordinary' | 'lookalike'): Promise<void> {
  if (mode === 'ordinary') throw new Error('ordinary workflow error');
  if (mode === 'lookalike') throw new Error('Script execution timed out after 5000ms');
  for (;;) {
    // Deliberately keep the VM busy until its execution timeout interrupts it.
  }
}

test.before(async (t) => {
  Runtime.install({
    logger: new DefaultLogger('WARN', (entry) => logs.push(entry)),
    telemetryOptions: { logging: { filter: 'warn', forward: {} } },
  });
  const env = await createTestWorkflowEnvironment();
  try {
    t.context = { env, workflowBundle: await createTestWorkflowBundle({ workflowsPath: __filename }) };
  } catch (err) {
    await env.teardown();
    throw err;
  }
});

test.after.always(async (t) => {
  await t.context.env?.teardown();
  await Runtime._instance?.shutdown();
});

for (const reuseV8Context of [false, true]) {
  for (const mode of ['timeout', 'ordinary', 'lookalike'] as const) {
    test.serial(`VM failure diagnostic (${mode}, reuseV8Context=${reuseV8Context})`, async (t) => {
      const { createWorker, startWorkflow } = helpers(t);
      const worker = await createWorker({ reuseV8Context, debugMode: false });
      logs.length = 0;
      await worker.runUntil(async () => {
        const handle = await startWorkflow(vmTimeoutWorkflow, { args: [mode], workflowTaskTimeout: '20s' });
        try {
          let failure: temporal.api.failure.v1.IFailure | null | undefined;
          await waitUntil(async () => {
            const history = await handle.fetchHistory();
            failure = history.events?.find((event) => event.workflowTaskFailedEventAttributes)
              ?.workflowTaskFailedEventAttributes?.failure;
            return failure != null;
          }, 20_000);
          t.is(failure?.source, 'TypeScriptSDK');
          if (mode === 'timeout') {
            t.regex(failure?.message ?? '', /\[TMPRL1101\]/);
            t.regex(failure?.message ?? '', /Script execution timed out after 5000ms/);
            t.regex(failure?.message ?? '', /https:\/\/.*TMPRL1101/);
            t.regex(failure?.stackTrace ?? '', /Script execution timed out after 5000ms/);
          } else {
            t.is(
              failure?.message,
              mode === 'ordinary' ? 'ordinary workflow error' : 'Script execution timed out after 5000ms'
            );
          }
          await waitUntil(async () => logs.some((entry) => entry.message === 'Failing workflow task'), 5_000);
          const failureLogs = logs.filter((entry) => entry.message === 'Failing workflow task');
          t.is(
            failureLogs.some((entry) => String(entry.meta?.failure).includes('TMPRL1101')),
            mode === 'timeout'
          );
        } finally {
          await handle.terminate();
        }
      });
    });
  }
}

test.serial('VM timeout diagnostic passes through a custom failure converter', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({
    workflowBundle: undefined,
    workflowsPath: __filename,
    bundlerOptions,
    dataConverter: { failureConverterPath: __filename },
    debugMode: false,
  });
  await worker.runUntil(async () => {
    const handle = await startWorkflow(vmTimeoutWorkflow, { args: ['timeout'], workflowTaskTimeout: '20s' });
    try {
      let failure: temporal.api.failure.v1.IFailure | null | undefined;
      await waitUntil(async () => {
        const history = await handle.fetchHistory();
        failure = history.events?.find((event) => event.workflowTaskFailedEventAttributes)
          ?.workflowTaskFailedEventAttributes?.failure;
        return failure != null;
      }, 20_000);
      t.is(failure?.message, 'Encoded failure');
      const attributes = defaultPayloadConverter.fromPayload<DefaultEncodedFailureAttributes>(
        failure!.encodedAttributes!
      );
      t.regex(attributes.message, /\[TMPRL1101\]/);
      t.regex(attributes.message, /Script execution timed out after 5000ms/);
    } finally {
      await handle.terminate();
    }
  });
});
