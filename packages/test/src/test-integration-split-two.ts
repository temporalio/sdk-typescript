/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import asyncRetry from 'async-retry';
import { v4 as uuid4 } from 'uuid';
import * as iface from '@temporalio/proto';
import { WorkflowContinuedAsNewError, WorkflowFailedError } from '@temporalio/client';
import {
  ApplicationFailure,
  defaultPayloadConverter,
  Payload,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from '@temporalio/common';
import { searchAttributePayloadConverter } from '@temporalio/common/lib/converter/payload-search-attributes';
import { msToNumber, tsToMs } from '@temporalio/common/lib/time';
import {
  decode as payloadDecode,
  decodeFromPayloadsAtIndex,
  decodeOptionalSinglePayload,
} from '@temporalio/common/lib/internal-non-workflow';

import { Context } from '@temporalio/activity';
import {
  condition,
  defineQuery,
  defineSignal,
  getCurrentDetails,
  proxyActivities,
  proxyLocalActivities,
  setCurrentDetails,
  setDefaultQueryHandler,
  setHandler,
  sleep,
  startChild,
} from '@temporalio/workflow';
import { temporal } from '@temporalio/proto';
import { configurableHelpers, createTestWorkflowBundle } from './helpers-integration';
import * as activities from './activities';
import * as workflows from './workflows';
import { makeTestFn, configMacro } from './helpers-integration-multi-codec';

// Note: re-export shared workflows (or long workflows)
//  - review the files where these workflows are shared
export * from './workflows';

const test = makeTestFn(() => createTestWorkflowBundle({ workflowsPath: __filename }));
test.macro(configMacro);

// FIXME: Unless we add .serial() here, ava tries to start all async tests in parallel, which
//        is ok in most environments, but has been causing flakyness in CI, especially on Windows.
//        We can probably avoid this by using larger runners, and there is some opportunity for
//        optimization here, but for now, let's just run these tests serially.
test.serial('WorkflowOptions are passed correctly with defaults', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow, taskQueue } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.argsAndReturn, {
    args: ['hey', undefined, Buffer.from('def')],
  });
  await worker.runUntil(handle.result());
  const execution = await handle.describe();
  t.deepEqual(execution.type, 'argsAndReturn');
  const indexedFields = execution.raw.workflowExecutionInfo!.searchAttributes!.indexedFields!;
  const indexedFieldKeys = Object.keys(indexedFields);

  let encodedId: any;
  if (indexedFieldKeys.includes('BinaryChecksums')) {
    encodedId = indexedFields.BinaryChecksums!;
  } else {
    encodedId = indexedFields.BuildIds!;
  }
  t.true(encodedId != null);

  const checksums = searchAttributePayloadConverter.fromPayload(encodedId);
  console.log(checksums);
  t.true(Array.isArray(checksums));
  t.regex((checksums as string[]).pop()!, /@temporalio\/worker@\d+\.\d+\.\d+/);
  t.is(execution.raw.executionConfig?.taskQueue?.name, taskQueue);
  t.is(
    execution.raw.executionConfig?.taskQueue?.kind,
    iface.temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_NORMAL
  );
  t.is(execution.raw.executionConfig?.workflowRunTimeout, null);
  t.is(execution.raw.executionConfig?.workflowExecutionTimeout, null);
});

test.serial('WorkflowOptions are passed correctly', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  // Throws because we use a different task queue
  const worker = await createWorkerWithDefaults(t);
  const options = {
    memo: { a: 'b' },
    searchAttributes: { CustomIntField: [3] },
    workflowRunTimeout: '2s',
    workflowExecutionTimeout: '3s',
    workflowTaskTimeout: '1s',
    taskQueue: 'diff-task-queue',
  } as const;
  const handle = await startWorkflow(workflows.sleeper, options);
  async function fromPayload(payload: Payload) {
    const payloadCodecs = env.client.options.dataConverter.payloadCodecs ?? [];
    const [decodedPayload] = await payloadDecode(payloadCodecs, [payload]);
    return defaultPayloadConverter.fromPayload(decodedPayload);
  }
  await t.throwsAsync(worker.runUntil(handle.result()), {
    instanceOf: WorkflowFailedError,
    message: 'Workflow execution timed out',
  });
  const execution = await handle.describe();
  t.deepEqual(
    execution.raw.workflowExecutionInfo?.type,
    iface.temporal.api.common.v1.WorkflowType.create({ name: 'sleeper' })
  );
  t.deepEqual(await fromPayload(execution.raw.workflowExecutionInfo!.memo!.fields!.a!), 'b');
  t.deepEqual(
    searchAttributePayloadConverter.fromPayload(
      execution.raw.workflowExecutionInfo!.searchAttributes!.indexedFields!.CustomIntField!
    ),
    [3]
  );
  t.deepEqual(execution.searchAttributes!.CustomIntField, [3]); // eslint-disable-line deprecation/deprecation
  t.is(execution.raw.executionConfig?.taskQueue?.name, 'diff-task-queue');
  t.is(
    execution.raw.executionConfig?.taskQueue?.kind,
    iface.temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_NORMAL
  );

  t.is(tsToMs(execution.raw.executionConfig!.workflowRunTimeout!), msToNumber(options.workflowRunTimeout));
  t.is(tsToMs(execution.raw.executionConfig!.workflowExecutionTimeout!), msToNumber(options.workflowExecutionTimeout));
  t.is(tsToMs(execution.raw.executionConfig!.defaultWorkflowTaskTimeout!), msToNumber(options.workflowTaskTimeout));
});

test.serial('WorkflowHandle.result() throws if terminated', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.sleeper, {
    args: [1000000],
  });
  await t.throwsAsync(
    worker.runUntil(async () => {
      await handle.terminate('hasta la vista baby');
      await handle.result();
    }),
    {
      instanceOf: WorkflowFailedError,
      message: 'hasta la vista baby',
    }
  );
});

test.serial('WorkflowHandle.result() throws if continued as new', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  await worker.runUntil(async () => {
    const originalWorkflowHandle = await startWorkflow(workflows.continueAsNewSameWorkflow, {
      followRuns: false,
    });
    let err = await t.throwsAsync(originalWorkflowHandle.result(), { instanceOf: WorkflowContinuedAsNewError });

    if (!(err instanceof WorkflowContinuedAsNewError)) return; // Type assertion
    const client = env.client;
    let continueWorkflowHandle = client.workflow.getHandle<typeof workflows.continueAsNewSameWorkflow>(
      originalWorkflowHandle.workflowId,
      err.newExecutionRunId,
      {
        followRuns: false,
      }
    );

    await continueWorkflowHandle.signal(workflows.continueAsNewSignal);
    err = await t.throwsAsync(continueWorkflowHandle.result(), {
      instanceOf: WorkflowContinuedAsNewError,
    });
    if (!(err instanceof WorkflowContinuedAsNewError)) return; // Type assertion

    continueWorkflowHandle = client.workflow.getHandle<typeof workflows.continueAsNewSameWorkflow>(
      continueWorkflowHandle.workflowId,
      err.newExecutionRunId
    );
    await continueWorkflowHandle.result();
  });
});

test.serial('WorkflowHandle.result() follows chain of execution', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  await worker.runUntil(
    executeWorkflow(workflows.continueAsNewSameWorkflow, {
      args: ['execute', 'none'],
    })
  );
  t.pass();
});

test.serial('continue-as-new-to-different-workflow', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults, loadedDataConverter } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const client = env.client;
  await worker.runUntil(async () => {
    const originalWorkflowHandle = await startWorkflow(workflows.continueAsNewToDifferentWorkflow, {
      followRuns: false,
    });
    const err = await t.throwsAsync(originalWorkflowHandle.result(), { instanceOf: WorkflowContinuedAsNewError });
    if (!(err instanceof WorkflowContinuedAsNewError)) return; // Type assertion
    const workflow = client.workflow.getHandle<typeof workflows.sleeper>(
      originalWorkflowHandle.workflowId,
      err.newExecutionRunId,
      {
        followRuns: false,
      }
    );
    await workflow.result();
    const info = await workflow.describe();
    t.is(info.raw.workflowExecutionInfo?.type?.name, 'sleeper');
    const history = await workflow.fetchHistory();
    const timeSlept = await decodeFromPayloadsAtIndex(
      loadedDataConverter,
      0,
      history?.events?.[0].workflowExecutionStartedEventAttributes?.input?.payloads
    );
    t.is(timeSlept, 1);
  });
});

test.serial('continue-as-new-to-same-workflow keeps memo and search attributes', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.continueAsNewSameWorkflow, {
    memo: {
      note: 'foo',
    },
    searchAttributes: {
      CustomKeywordField: ['test-value'],
      CustomIntField: [1],
    },
    followRuns: true,
  });
  await worker.runUntil(async () => {
    await handle.signal(workflows.continueAsNewSignal);
    await handle.result();
    const execution = await handle.describe();
    t.not(execution.runId, handle.firstExecutionRunId);
    t.deepEqual(execution.memo, { note: 'foo' });
    t.deepEqual(execution.searchAttributes!.CustomKeywordField, ['test-value']); // eslint-disable-line deprecation/deprecation
    t.deepEqual(execution.searchAttributes!.CustomIntField, [1]); // eslint-disable-line deprecation/deprecation
  });
});

test.serial(
  'continue-as-new-to-different-workflow keeps memo and search attributes by default',
  configMacro,
  async (t, config) => {
    const { env, createWorkerWithDefaults } = config;

    const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
    const worker = await createWorkerWithDefaults(t);
    const handle = await startWorkflow(workflows.continueAsNewToDifferentWorkflow, {
      followRuns: true,
      memo: {
        note: 'foo',
      },
      searchAttributes: {
        CustomKeywordField: ['test-value'],
        CustomIntField: [1],
      },
    });
    await worker.runUntil(async () => {
      await handle.result();
      const info = await handle.describe();
      t.is(info.type, 'sleeper');
      t.not(info.runId, handle.firstExecutionRunId);
      t.deepEqual(info.memo, { note: 'foo' });
      t.deepEqual(info.searchAttributes!.CustomKeywordField, ['test-value']); // eslint-disable-line deprecation/deprecation
      t.deepEqual(info.searchAttributes!.CustomIntField, [1]); // eslint-disable-line deprecation/deprecation
    });
  }
);

test.serial(
  'continue-as-new-to-different-workflow can set memo and search attributes',
  configMacro,
  async (t, config) => {
    const { env, createWorkerWithDefaults } = config;
    const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
    const worker = await createWorkerWithDefaults(t);
    const handle = await startWorkflow(workflows.continueAsNewToDifferentWorkflow, {
      args: [
        1,
        {
          memo: {
            note: 'bar',
          },
          searchAttributes: {
            CustomKeywordField: ['test-value-2'],
            CustomIntField: [3],
          },
        },
      ],
      followRuns: true,
      memo: {
        note: 'foo',
      },
      searchAttributes: {
        CustomKeywordField: ['test-value'],
        CustomIntField: [1],
      },
    });
    await worker.runUntil(async () => {
      await handle.result();
      const info = await handle.describe();
      t.is(info.type, 'sleeper');
      t.not(info.runId, handle.firstExecutionRunId);
      t.deepEqual(info.memo, { note: 'bar' });
      t.deepEqual(info.searchAttributes!.CustomKeywordField, ['test-value-2']); // eslint-disable-line deprecation/deprecation
      t.deepEqual(info.searchAttributes!.CustomIntField, [3]); // eslint-disable-line deprecation/deprecation
    });
  }
);

test.serial('signalWithStart works as intended and returns correct runId', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { taskQueue } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const client = env.client;
  const originalWorkflowHandle = await client.workflow.signalWithStart(workflows.interruptableWorkflow, {
    taskQueue,
    workflowId: uuid4(),
    signal: workflows.interruptSignal,
    signalArgs: ['interrupted from signalWithStart'],
  });
  await worker.runUntil(async () => {
    let err: WorkflowFailedError | undefined = await t.throwsAsync(originalWorkflowHandle.result(), {
      instanceOf: WorkflowFailedError,
    });
    if (!(err?.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.message, 'interrupted from signalWithStart');

    // Test returned runId
    const handle = client.workflow.getHandle<typeof workflows.interruptableWorkflow>(
      originalWorkflowHandle.workflowId,
      originalWorkflowHandle.signaledRunId
    );
    err = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });
    if (!(err?.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.message, 'interrupted from signalWithStart');
  });
});

test.serial('activity-failures', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t, { activities });
  await worker.runUntil(executeWorkflow(workflows.activityFailures));
  t.pass();
});

export async function sleepInvalidDuration(): Promise<void> {
  await sleep(0);
  await new Promise((resolve) => setTimeout(resolve, -1));
}

test.serial('sleepInvalidDuration is caught in Workflow runtime', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;

  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  await worker.runUntil(executeWorkflow(sleepInvalidDuration));
  t.pass();
});

test.serial('unhandledRejection causes WFT to fail', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.throwUnhandledRejection, {
    // throw an exception that our worker can associate with a running workflow
    args: [{ crashWorker: false }],
  });
  await worker.runUntil(
    asyncRetry(
      async () => {
        const history = await handle.fetchHistory();
        const wftFailedEvent = history.events?.find((ev) => ev.workflowTaskFailedEventAttributes);
        if (wftFailedEvent === undefined) {
          throw new Error('No WFT failed event');
        }
        const failure = wftFailedEvent.workflowTaskFailedEventAttributes?.failure;
        if (!failure) {
          t.fail();
          return;
        }
        t.is(failure.message, 'Unhandled Promise rejection: Error: unhandled rejection');
        t.true(failure.stackTrace?.includes(`Error: unhandled rejection`));
        t.is(failure.cause?.cause?.message, 'root failure');
      },
      { minTimeout: 300, factor: 1, retries: 100 }
    )
  );
  await handle.terminate();
});

export async function throwObject(): Promise<void> {
  throw { plainObject: true };
}

test.serial('throwObject includes message with our recommendation', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(throwObject);
  await worker.runUntil(
    asyncRetry(
      async () => {
        const history = await handle.fetchHistory();
        const wftFailedEvent = history.events?.find((ev) => ev.workflowTaskFailedEventAttributes);
        if (wftFailedEvent === undefined) {
          throw new Error('No WFT failed event');
        }
        const failure = wftFailedEvent.workflowTaskFailedEventAttributes?.failure;
        if (!failure) {
          t.fail();
          return;
        }
        t.is(
          failure.message,
          '{"plainObject":true} [A non-Error value was thrown from your code. We recommend throwing Error objects so that we can provide a stack trace]'
        );
      },
      { minTimeout: 300, factor: 1, retries: 100 }
    )
  );
  await handle.terminate();
});

export async function throwBigInt(): Promise<void> {
  throw 42n;
}

test.serial('throwBigInt includes message with our recommendation', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(throwBigInt);
  await worker.runUntil(
    asyncRetry(
      async () => {
        const history = await handle.fetchHistory();
        const wftFailedEvent = history.events?.find((ev) => ev.workflowTaskFailedEventAttributes);
        if (wftFailedEvent === undefined) {
          throw new Error('No WFT failed event');
        }
        const failure = wftFailedEvent.workflowTaskFailedEventAttributes?.failure;
        if (!failure) {
          t.fail();
          return;
        }
        t.is(
          failure.message,
          '42 [A non-Error value was thrown from your code. We recommend throwing Error objects so that we can provide a stack trace]'
        );
      },
      { minTimeout: 300, factor: 1, retries: 100 }
    )
  );
  await handle.terminate();
});

test.serial('Workflow RetryPolicy kicks in with retryable failure', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.throwAsync, {
    args: ['retryable'],
    retry: {
      initialInterval: 1,
      maximumInterval: 1,
      maximumAttempts: 2,
    },
  });
  await worker.runUntil(async () => {
    await t.throwsAsync(handle.result());
    // Verify retry happened
    const { runId } = await handle.describe();
    t.not(runId, handle.firstExecutionRunId);
  });
});

test.serial('Workflow RetryPolicy ignored with nonRetryable failure', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.throwAsync, {
    args: ['nonRetryable'],
    retry: {
      initialInterval: 1,
      maximumInterval: 1,
      maximumAttempts: 2,
    },
  });
  await worker.runUntil(async () => {
    await t.throwsAsync(handle.result());
    const res = await handle.describe();
    t.is(
      res.raw.workflowExecutionInfo?.status,
      iface.temporal.api.enums.v1.WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_FAILED
    );
    // Verify retry did not happen
    const { runId } = await handle.describe();
    t.is(runId, handle.firstExecutionRunId);
  });
});

test.serial('WorkflowClient.start fails with WorkflowExecutionAlreadyStartedError', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow, taskQueue } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const client = env.client;
  const handle = await startWorkflow(workflows.sleeper, {
    args: [10000000],
  });
  try {
    await worker.runUntil(
      t.throwsAsync(
        client.workflow.start(workflows.sleeper, {
          taskQueue,
          workflowId: handle.workflowId,
        }),
        {
          instanceOf: WorkflowExecutionAlreadyStartedError,
          message: 'Workflow execution already started',
        }
      )
    );
  } finally {
    await handle.terminate();
  }
});

test.serial(
  'WorkflowClient.signalWithStart fails with WorkflowExecutionAlreadyStartedError',
  configMacro,
  async (t, config) => {
    const { env, createWorkerWithDefaults } = config;
    const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
    const worker = await createWorkerWithDefaults(t);
    const client = env.client;
    const handle = await startWorkflow(workflows.sleeper);
    await worker.runUntil(async () => {
      await handle.result();
      await t.throwsAsync(
        client.workflow.signalWithStart(workflows.sleeper, {
          taskQueue: 'test',
          workflowId: handle.workflowId,
          signal: workflows.interruptSignal,
          signalArgs: ['interrupted from signalWithStart'],
          workflowIdReusePolicy: 'REJECT_DUPLICATE',
        }),
        {
          instanceOf: WorkflowExecutionAlreadyStartedError,
          message: 'Workflow execution already started',
        }
      );
    });
  }
);

test.serial('Handle from WorkflowClient.start follows only own execution chain', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const client = env.client;
  const handleFromThrowerStart = await startWorkflow(workflows.throwAsync);
  const handleFromGet = client.workflow.getHandle(handleFromThrowerStart.workflowId);
  await worker.runUntil(async () => {
    await t.throwsAsync(handleFromGet.result(), { message: /.*/ });
    const handleFromSleeperStart = await client.workflow.start(workflows.sleeper, {
      taskQueue: 'test',
      workflowId: handleFromThrowerStart.workflowId,
      args: [1_000_000],
    });
    try {
      await t.throwsAsync(handleFromThrowerStart.result(), { message: 'Workflow execution failed' });
    } finally {
      await handleFromSleeperStart.terminate();
    }
  });
});

test.serial(
  'Handle from WorkflowClient.signalWithStart follows only own execution chain',
  configMacro,
  async (t, config) => {
    const { env, createWorkerWithDefaults } = config;
    const { taskQueue } = configurableHelpers(t, t.context.workflowBundle, env);
    const worker = await createWorkerWithDefaults(t);
    const client = env.client;
    const handleFromThrowerStart = await client.workflow.signalWithStart(workflows.throwAsync, {
      taskQueue,
      workflowId: uuid4(),
      signal: 'unblock',
    });
    const handleFromGet = client.workflow.getHandle(handleFromThrowerStart.workflowId);
    await worker.runUntil(async () => {
      await t.throwsAsync(handleFromGet.result(), { message: /.*/ });
      const handleFromSleeperStart = await client.workflow.start(workflows.sleeper, {
        taskQueue,
        workflowId: handleFromThrowerStart.workflowId,
        args: [1_000_000],
      });
      try {
        await t.throwsAsync(handleFromThrowerStart.result(), { message: 'Workflow execution failed' });
      } finally {
        await handleFromSleeperStart.terminate();
      }
    });
  }
);

test.serial('Handle from WorkflowClient.getHandle follows only own execution chain', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow, taskQueue } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const client = env.client;
  const handleFromThrowerStart = await startWorkflow(workflows.throwAsync);
  const handleFromGet = client.workflow.getHandle(handleFromThrowerStart.workflowId, undefined, {
    firstExecutionRunId: handleFromThrowerStart.firstExecutionRunId,
  });
  await worker.runUntil(async () => {
    await t.throwsAsync(handleFromThrowerStart.result(), { message: /.*/ });
    const handleFromSleeperStart = await client.workflow.start(workflows.sleeper, {
      taskQueue,
      workflowId: handleFromThrowerStart.workflowId,
      args: [1_000_000],
    });
    try {
      await t.throwsAsync(handleFromGet.result(), { message: 'Workflow execution failed' });
    } finally {
      await handleFromSleeperStart.terminate();
    }
  });
});

test.serial('Handle from WorkflowClient.start terminates run after continue as new', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const client = env.client;
  const handleFromStart = await startWorkflow(workflows.continueAsNewToDifferentWorkflow, {
    args: [1_000_000],
  });
  const handleFromGet = client.workflow.getHandle(handleFromStart.workflowId, handleFromStart.firstExecutionRunId, {
    followRuns: false,
  });
  await worker.runUntil(async () => {
    await t.throwsAsync(handleFromGet.result(), { instanceOf: WorkflowContinuedAsNewError });
    await handleFromStart.terminate('Expect workflow to terminate due to CAN');
    await t.throwsAsync(handleFromStart.result(), { message: 'Expect workflow to terminate due to CAN' });
  });
});

test.serial(
  'Handle from WorkflowClient.getHandle does not terminate run after continue as new if given runId',
  configMacro,
  async (t, config) => {
    const { env, createWorkerWithDefaults } = config;
    const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
    const worker = await createWorkerWithDefaults(t);
    const client = env.client;
    const handleFromStart = await startWorkflow(workflows.continueAsNewToDifferentWorkflow, {
      args: [1_000_000],
      followRuns: false,
    });
    const handleFromGet = client.workflow.getHandle(handleFromStart.workflowId, handleFromStart.firstExecutionRunId);
    await worker.runUntil(async () => {
      await t.throwsAsync(handleFromStart.result(), { instanceOf: WorkflowContinuedAsNewError });
      try {
        await t.throwsAsync(handleFromGet.terminate(), {
          instanceOf: WorkflowNotFoundError,
          message: 'workflow execution already completed',
        });
      } finally {
        await client.workflow.getHandle(handleFromStart.workflowId).terminate();
      }
    });
  }
);

test.serial(
  'Runtime does not issue cancellations for activities and timers that throw during validation',
  configMacro,
  async (t, config) => {
    const { env, createWorkerWithDefaults } = config;
    const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
    const worker = await createWorkerWithDefaults(t);
    await worker.runUntil(executeWorkflow(workflows.cancelScopeOnFailedValidation));
    t.pass();
  }
);

const mutateWorkflowStateQuery = defineQuery<void>('mutateWorkflowState');
export async function queryAndCondition(): Promise<void> {
  let mutated = false;
  // Not a valid query, used to verify that condition isn't triggered for query jobs
  setHandler(mutateWorkflowStateQuery, () => void (mutated = true));
  await condition(() => mutated);
}

test.serial('Query does not cause condition to be triggered', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;

  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(queryAndCondition);
  await worker.runUntil(handle.query(mutateWorkflowStateQuery));
  await handle.terminate();
  // Worker did not crash
  t.pass();
});

const completeSignal = defineSignal('complete');
const definedQuery = defineQuery<QueryNameAndArgs>('query-handler-type');

interface QueryNameAndArgs {
  name: string;
  queryName?: string;
  args: any[];
}

export async function workflowWithMaybeDefinedQuery(useDefinedQuery: boolean): Promise<void> {
  let complete = false;
  setHandler(completeSignal, () => {
    complete = true;
  });
  setDefaultQueryHandler((queryName: string, ...args: any[]) => {
    return { name: 'default', queryName, args };
  });
  if (useDefinedQuery) {
    setHandler(definedQuery, (...args: any[]) => {
      return { name: definedQuery.name, args };
    });
  }

  await condition(() => complete);
}

test.serial('default query handler is used if requested query does not exist', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t, { activities });
  const handle = await startWorkflow(workflowWithMaybeDefinedQuery, {
    args: [false],
  });
  await worker.runUntil(async () => {
    const args = ['test', 'args'];
    const result = await handle.query(definedQuery, ...args);
    t.deepEqual(result, { name: 'default', queryName: definedQuery.name, args });
  });
});

test.serial('default query handler is not used if requested query exists', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t, { activities });
  const handle = await startWorkflow(workflowWithMaybeDefinedQuery, {
    args: [true],
  });
  await worker.runUntil(async () => {
    const args = ['test', 'args'];
    const result = await handle.query('query-handler-type', ...args);
    t.deepEqual(result, { name: definedQuery.name, args });
  });
});

export async function completableWorkflow(completes: boolean): Promise<void> {
  await condition(() => completes);
}

export async function userMetadataWorkflow(): Promise<{
  currentDetails: string;
  childWorkflowId: string;
  childRunId: string;
}> {
  let done = false;
  const signalDef = defineSignal('done');
  setHandler(
    signalDef,
    () => {
      done = true;
    },
    { description: 'signal-desc' }
  );

  // That workflow should call an activity (with summary)
  const { activityWithSummary } = proxyActivities({
    scheduleToCloseTimeout: '10s',
    scheduleToStartTimeout: '10s',
  });
  await activityWithSummary.executeWithOptions(
    {
      summary: 'activity summary',
      retry: {
        initialInterval: '1s',
        maximumAttempts: 5,
        maximumInterval: '10s',
      },
      scheduleToStartTimeout: '5s',
    },
    []
  );
  const { localActivityWithSummary } = proxyLocalActivities({ scheduleToCloseTimeout: '10s' });
  await localActivityWithSummary.executeWithOptions(
    {
      summary: 'local activity summary',
      retry: {
        maximumAttempts: 2,
        nonRetryableErrorTypes: ['CustomError'],
      },
      scheduleToStartTimeout: '5s',
    },
    []
  );
  // Timer (with summary)
  await sleep(5, { summary: 'timer summary' });
  // Set current details
  setCurrentDetails('current wf details');
  // Start child workflow
  const childHandle = await startChild(completableWorkflow, {
    args: [false],
    staticDetails: 'child details',
    staticSummary: 'child summary',
  });

  await condition(() => done);
  return {
    currentDetails: getCurrentDetails(),
    childWorkflowId: childHandle.workflowId,
    childRunId: childHandle.firstExecutionRunId,
  };
}

test.serial('User metadata on workflow, timer, activity, child', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);

  const worker = await createWorkerWithDefaults(t, {
    activities: {
      async activityWithSummary() {},
      async localActivityWithSummary() {},
    },
  });

  await worker.runUntil(async () => {
    // Start a workflow with static details
    const handle = await startWorkflow(userMetadataWorkflow, {
      staticSummary: 'wf static summary',
      staticDetails: 'wf static details',
    });
    // Describe workflow -> static summary, static details
    const desc = await handle.describe();
    t.is(await desc.staticSummary(), 'wf static summary');
    t.is(await desc.staticDetails(), 'wf static details');

    await handle.signal('done');
    const res = await handle.result();
    t.is(res.currentDetails, 'current wf details');

    // Get child workflow handle and verify metadata
    const childHandle = env.client.workflow.getHandle(res.childWorkflowId, res.childRunId);
    const childDesc = await childHandle.describe();
    t.is(await childDesc.staticSummary(), 'child summary');
    t.is(await childDesc.staticDetails(), 'child details');

    // Get history events for main workflow.
    const resp = await env.client.workflowService.getWorkflowExecutionHistory({
      namespace: env.client.options.namespace,
      execution: {
        workflowId: handle.workflowId,
        runId: handle.firstExecutionRunId,
      },
    });
    for (const event of resp.history?.events ?? []) {
      if (event.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED) {
        t.deepEqual(
          await decodeOptionalSinglePayload(env.client.options.loadedDataConverter, event.userMetadata?.summary),
          'wf static summary'
        );
        t.deepEqual(
          await decodeOptionalSinglePayload(env.client.options.loadedDataConverter, event.userMetadata?.details),
          'wf static details'
        );
      } else if (event.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) {
        t.deepEqual(
          await decodeOptionalSinglePayload(env.client.options.loadedDataConverter, event.userMetadata?.summary),
          'activity summary'
        );
        // Assert that the overriden activity options are what we expect.
        const attrs = event.activityTaskScheduledEventAttributes;
        t.is(tsToMs(attrs?.scheduleToCloseTimeout), 10000);
        t.is(tsToMs(attrs?.scheduleToStartTimeout), 5000);
        const retryPolicy = attrs?.retryPolicy;
        t.is(retryPolicy?.maximumAttempts, 5);
        t.is(tsToMs(retryPolicy?.initialInterval), 1000);
        t.is(tsToMs(retryPolicy?.maximumInterval), 10000);
      } else if (event.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_TIMER_STARTED) {
        t.deepEqual(
          await decodeOptionalSinglePayload(env.client.options.loadedDataConverter, event.userMetadata?.summary),
          'timer summary'
        );
      }
    }
    // Get history events for child workflow.
    const childResp = await env.client.workflowService.getWorkflowExecutionHistory({
      namespace: env.client.options.namespace,
      execution: {
        workflowId: res.childWorkflowId,
        runId: res.childRunId,
      },
    });

    for (const event of childResp.history?.events ?? []) {
      if (event.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED) {
        t.is(
          await decodeOptionalSinglePayload(env.client.options.loadedDataConverter, event.userMetadata?.summary),
          'child summary'
        );
        t.is(
          await decodeOptionalSinglePayload(env.client.options.loadedDataConverter, event.userMetadata?.details),
          'child details'
        );
      }
    }
    // Run metadata query -> get current details
    const wfMetadata = (await handle.query('__temporal_workflow_metadata')) as temporal.api.sdk.v1.IWorkflowMetadata;
    t.is(wfMetadata.definition?.signalDefinitions?.length, 1);
    t.is(wfMetadata.definition?.signalDefinitions?.[0].name, 'done');
    t.is(wfMetadata.definition?.signalDefinitions?.[0].description, 'signal-desc');
    t.is(wfMetadata.definition?.queryDefinitions?.length, 3); // default queries
    t.is(wfMetadata.currentDetails, 'current wf details');
  });
});

export async function activityContextExposesClientConnectionParentWorkflow(): Promise<string> {
  return await proxyActivities({
    startToCloseTimeout: '10s',
  })['foo']();
}

export async function activityContextExposesClientConnectionChildWorkflow(comment: string): Promise<string> {
  return `child(${comment})`;
}

test('Activity Context exposes Client connection', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow, taskQueue } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t, {
    activities: {
      foo: async () => {
        const { client } = Context.current();
        return await client.workflow.execute(activityContextExposesClientConnectionChildWorkflow, {
          workflowId: uuid4(),
          taskQueue,
          args: ['not intercepted'],
        });
      },
    },
    interceptors: {
      client: {
        workflow: [
          {
            async start(input, next) {
              input.options.args = ['native client intercepted'];
              return await next(input);
            },
          },
        ],
      },
    },
  });
  const res = await worker.runUntil(async () => {
    const handle = await startWorkflow(activityContextExposesClientConnectionParentWorkflow);
    return await handle.result();
  });
  t.is(res, 'child(native client intercepted)');
});
