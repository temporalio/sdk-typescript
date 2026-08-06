import { randomUUID } from 'crypto';
import { Client, WorkflowClient, WorkflowFailedError } from '@temporalio/client';
import { tsToMs } from '@temporalio/common/lib/time';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import * as workflows from './workflows';
import {
  conflictId,
  dontExecuteEagerActivity,
  executeEagerActivity,
  helloWorkflow,
  parent,
  runTestActivity,
} from './integration-workflows-common';
import { helpers, makeTestFunction } from './helpers-integration';

export * from './integration-workflows-common';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
});

test('Workflow fails if it tries to start a child with an existing workflow ID', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const err = await t.throwsAsync(executeWorkflow(parent), {
      instanceOf: WorkflowFailedError,
    });
    t.true(
      err instanceof WorkflowFailedError &&
        err.cause?.name === 'TemporalFailure' &&
        err.cause?.message === 'Workflow execution already started'
    );
  });
});

test('Start of workflow is delayed', async (t) => {
  const { startWorkflow } = helpers(t);
  // This workflow never runs
  const handle = await startWorkflow(runTestActivity, {
    startDelay: '5678s',
  });
  const { events } = await handle.fetchHistory();
  const workflowExecutionStartedEvent = events?.find((ev) => ev.workflowExecutionStartedEventAttributes);
  const startDelay = workflowExecutionStartedEvent?.workflowExecutionStartedEventAttributes?.firstWorkflowTaskBackoff;
  t.is(tsToMs(startDelay), 5678000);
});

test('Start of workflow respects workflow id conflict policy', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
  const wfid = `${taskQueue}-` + randomUUID();
  const client = t.context.env.client;

  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await client.workflow.start(conflictId, {
      taskQueue,
      workflowId: wfid,
    });
    const handleWithRunId = client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);

    // Confirm another fails by default
    const err = await t.throwsAsync(
      client.workflow.start(conflictId, {
        taskQueue,
        workflowId: wfid,
      }),
      {
        instanceOf: WorkflowExecutionAlreadyStartedError,
      }
    );

    t.true(err instanceof WorkflowExecutionAlreadyStartedError);
    t.is((err as WorkflowExecutionAlreadyStartedError).runId, handle.firstExecutionRunId);

    // Confirm fails with explicit option
    const err1 = await t.throwsAsync(
      client.workflow.start(conflictId, {
        taskQueue,
        workflowId: wfid,
        workflowIdConflictPolicy: 'FAIL',
      }),
      {
        instanceOf: WorkflowExecutionAlreadyStartedError,
      }
    );

    t.true(err1 instanceof WorkflowExecutionAlreadyStartedError);
    t.is((err1 as WorkflowExecutionAlreadyStartedError).runId, handle.firstExecutionRunId);

    // Confirm gives back same handle
    const handle2 = await client.workflow.start(conflictId, {
      taskQueue,
      workflowId: wfid,
      workflowIdConflictPolicy: 'USE_EXISTING',
    });

    const desc = await handleWithRunId.describe();
    const desc2 = await handle2.describe();

    t.is(desc.runId, desc2.runId);
    t.is(desc.status.name, 'RUNNING');
    t.is(desc2.status.name, 'RUNNING');

    // Confirm terminates and starts new
    const handle3 = await client.workflow.start(conflictId, {
      taskQueue,
      workflowId: wfid,
      workflowIdConflictPolicy: 'TERMINATE_EXISTING',
    });

    const descWithRunId = await handleWithRunId.describe();
    const desc3 = await handle3.describe();
    t.not(descWithRunId.runId, desc3.runId);
    t.is(descWithRunId.status.name, 'TERMINATED');
    t.is(desc3.status.name, 'RUNNING');
  });
});

// FIXME: This test is passing, but spitting out "signalTarget not exported by
//        the workflow bundle" errors. To be revisited at a later time.
test('Start of workflow with signal respects conflict id policy', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
  const wfid = `${taskQueue}-` + randomUUID();
  const client = t.context.env.client;
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await client.workflow.start(workflows.signalTarget, {
      taskQueue,
      workflowId: wfid,
    });
    const handleWithRunId = client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);

    // Confirm gives back same handle is the default policy
    const handle2 = await t.context.env.client.workflow.signalWithStart(workflows.signalTarget, {
      taskQueue,
      workflowId: wfid,
      signal: workflows.argsTestSignal,
      signalArgs: [123, 'kid'],
    });
    const desc = await handleWithRunId.describe();
    const desc2 = await handle2.describe();

    t.deepEqual(desc.runId, desc2.runId);
    t.deepEqual(desc.status.name, 'RUNNING');
    t.deepEqual(desc2.status.name, 'RUNNING');

    // Confirm terminates and starts new
    const handle3 = await t.context.env.client.workflow.signalWithStart(workflows.signalTarget, {
      taskQueue,
      workflowId: wfid,
      signal: workflows.argsTestSignal,
      signalArgs: [123, 'kid'],
      workflowIdConflictPolicy: 'TERMINATE_EXISTING',
    });

    const descWithRunId = await handleWithRunId.describe();
    const desc3 = await handle3.describe();
    t.true(descWithRunId.runId !== desc3.runId);
    t.deepEqual(descWithRunId.status.name, 'TERMINATED');
    t.deepEqual(desc3.status.name, 'RUNNING');
  });
});

test('Start of workflow with signal is delayed', async (t) => {
  const { taskQueue } = helpers(t);
  // This workflow never runs
  const handle = await t.context.env.client.workflow.signalWithStart(workflows.interruptableWorkflow, {
    workflowId: randomUUID(),
    taskQueue,
    startDelay: '4678s',
    signal: workflows.interruptSignal,
    signalArgs: ['Never called'],
  });

  const { events } = await handle.fetchHistory();
  const workflowExecutionStartedEvent = events?.find((ev) => ev.workflowExecutionStartedEventAttributes);
  const startDelay = workflowExecutionStartedEvent?.workflowExecutionStartedEventAttributes?.firstWorkflowTaskBackoff;
  t.is(tsToMs(startDelay), 4678000);
});

test('Worker requests Eager Activity Dispatch if possible', async (t) => {
  const { createWorker, startWorkflow, createNativeConnection } = helpers(t);

  // If eager activity dispatch is working, then the task will always be dispatched to the workflow
  // worker. Otherwise, chances are 50%-50% for either workers. The test workflow schedule the
  // activity 30 times to make sure that the workflow worker is really getting the task thanks to
  // eager activity dispatch, and not out of pure luck.

  const activityWorker = await createWorker({
    activities: {
      testActivity: () => 'activity-only-worker',
    },
    // Override the default workflow bundle, to make this an activity-only worker
    workflowBundle: undefined,
  });
  const workflowWorkerConnection = await createNativeConnection();
  t.teardown(() => workflowWorkerConnection.close());
  const workflowWorker = await createWorker({
    connection: workflowWorkerConnection,
    activities: {
      testActivity: () => 'workflow-and-activity-worker',
    },
  });
  const handle = await startWorkflow(executeEagerActivity);
  await activityWorker.runUntil(workflowWorker.runUntil(handle.result()));
  const { events } = await handle.fetchHistory();

  t.false(events?.some?.((ev) => ev.activityTaskTimedOutEventAttributes));
  const activityTaskStarted = events?.filter?.((ev) => ev.activityTaskStartedEventAttributes);
  t.is(activityTaskStarted?.length, 30);
  t.true(activityTaskStarted?.every((ev) => ev.activityTaskStartedEventAttributes?.attempt === 1));
});

test("Worker doesn't request Eager Activity Dispatch if no activities are registered", async (t) => {
  const { createNativeConnection, createWorker, startWorkflow } = helpers(t);

  // If the activity was eagerly dispatched to the Workflow worker even though it is a Workflow-only
  // worker, then the activity execution will timeout (because tasks are not being polled) or
  // otherwise fail (because no activity is registered under that name). Therefore, if the history
  // shows only one attempt for that activity and no timeout, that can only mean that the activity
  // was not eagerly dispatched.

  const activityWorker = await createWorker({
    activities: {
      testActivity: () => 'success',
    },
    // Override the default workflow bundle, to make this an activity-only worker
    workflowBundle: undefined,
  });
  const workflowWorkerConnection = await createNativeConnection();
  t.teardown(() => workflowWorkerConnection.close());
  const workflowWorker = await createWorker({
    connection: workflowWorkerConnection,
    activities: {},
  });
  const handle = await startWorkflow(dontExecuteEagerActivity);
  const result = await activityWorker.runUntil(workflowWorker.runUntil(handle.result()));
  const { events } = await handle.fetchHistory();

  t.is(result, 'success');
  t.false(events?.some?.((ev) => ev.activityTaskTimedOutEventAttributes));
  const activityTaskStarted = events?.filter?.((ev) => ev.activityTaskStartedEventAttributes);
  t.is(activityTaskStarted?.length, 1);
  t.is(activityTaskStarted?.[0]?.activityTaskStartedEventAttributes?.attempt, 1);
});

test('Workflow can be started eagerly with shared NativeConnection', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
  const client = new Client({
    connection: t.context.env.nativeConnection,
    namespace: t.context.env.client.options.namespace,
  });

  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await client.workflow.start(helloWorkflow, {
      args: ['Temporal'],
      workflowId: `eager-workflow-${randomUUID()}`,
      taskQueue,
      requestEagerStart: true,
      workflowTaskTimeout: '1h', // hang if retry needed
    });

    t.true(handle.eagerlyStarted);

    const result = await handle.result();
    t.is(result, 'Hello, Temporal!');
  });
});

test('Error thrown when requestEagerStart is used with regular Connection', async (t) => {
  const { taskQueue } = helpers(t);

  const client = new WorkflowClient({ connection: t.context.env.connection });

  await t.throwsAsync(
    client.start(helloWorkflow, {
      args: ['Temporal'],
      workflowId: `eager-workflow-error-${randomUUID()}`,
      taskQueue,
      requestEagerStart: true,
    }),
    {
      message: /Eager workflow start requires a NativeConnection/,
    }
  );
});
