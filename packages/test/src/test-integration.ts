/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import anyTest, { TestInterface } from 'ava';
import ms from 'ms';
import { v4 as uuid4 } from 'uuid';
import dedent from 'dedent';
import { WorkflowClient } from '@temporalio/client';
import {
  ChildWorkflowFailure,
  defaultDataConverter,
  RetryState,
  TerminatedFailure,
  TimeoutFailure,
  TimeoutType,
  tsToMs,
  WorkflowExecution,
} from '@temporalio/common';
import { Worker, DefaultLogger, Core } from '@temporalio/worker';
import * as iface from '@temporalio/proto';
import {
  WorkflowExecutionContinuedAsNewError,
  WorkflowExecutionFailedError,
  WorkflowExecutionTerminatedError,
  WorkflowExecutionTimedOutError,
  ActivityFailure,
  ApplicationFailure,
} from '@temporalio/client';
import * as activities from './activities';
import * as workflows from './workflows';
import { u8, RUN_INTEGRATION_TESTS, cleanStackTrace } from './helpers';
import { withZeroesHTTPServer } from './zeroes-http-server';

const { EVENT_TYPE_TIMER_STARTED, EVENT_TYPE_TIMER_FIRED, EVENT_TYPE_TIMER_CANCELED } =
  iface.temporal.api.enums.v1.EventType;

const timerEventTypes = new Set([EVENT_TYPE_TIMER_STARTED, EVENT_TYPE_TIMER_FIRED, EVENT_TYPE_TIMER_CANCELED]);
const CHANGE_MARKER_NAME = 'core_patch';

export interface Context {
  worker: Worker;
  client: WorkflowClient;
  runPromise: Promise<void>;
}

const test = anyTest as TestInterface<Context>;
const namespace = 'default';

if (RUN_INTEGRATION_TESTS) {
  test.before(async (t) => {
    const logger = new DefaultLogger('DEBUG');
    // Use forwarded logging from core
    await Core.install({ logger, telemetryOptions: { logForwardingLevel: 'INFO' } });
    const worker = await Worker.create({
      workflowsPath: `${__dirname}/workflows`,
      activities,
      nodeModulesPath: `${__dirname}/../../../node_modules`,
      taskQueue: 'test',
    });

    const runPromise = worker.run();
    // Catch the error here to avoid unhandled rejection
    runPromise.catch((err) => {
      console.error('Caught error while worker was running', err);
    });
    t.context = { worker, runPromise, client: new WorkflowClient() };
  });
  test.after.always(async (t) => {
    t.context.worker.shutdown();
    await t.context.runPromise;
  });

  test('Workflow not found results in failure', async (t) => {
    const client = new WorkflowClient();
    const promise = client.execute({ taskQueue: 'test' }, 'not-found');
    const err: WorkflowExecutionFailedError = await t.throwsAsync(() => promise, {
      instanceOf: WorkflowExecutionFailedError,
    });
    if (!(err.cause instanceof ApplicationFailure)) {
      t.fail('Expected err.cause to be an instance of ApplicationFailure');
      return;
    }
    t.is(err.cause.type, 'ReferenceError');
    t.is(err.cause.message, "'not-found' is not a function");
    t.true(err.cause.nonRetryable);
    t.is(err.cause.stack, "ApplicationFailure: 'not-found' is not a function");
  });

  test('args-and-return', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.argsAndReturn, { taskQueue: 'test' });
    const res = await workflow.execute('Hello', undefined, u8('world!'));
    t.is(res, 'Hello, world!');
  });

  test('cancel-fake-progress', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.cancelFakeProgress, { taskQueue: 'test' });
    await workflow.execute();
    t.pass();
  });

  test('cancel-http-request', async (t) => {
    const { client } = t.context;
    await withZeroesHTTPServer(async (port) => {
      const url = `http://127.0.0.1:${port}`;
      const workflow = client.createWorkflowHandle(workflows.cancellableHTTPRequest, { taskQueue: 'test' });
      await workflow.execute(url);
    });
    t.pass();
  });

  test('activity-failure', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.activityFailure, { taskQueue: 'test' });
    const err: WorkflowExecutionFailedError = await t.throwsAsync(workflow.execute(), {
      instanceOf: WorkflowExecutionFailedError,
    });
    t.is(err.message, 'Workflow execution failed');
    if (!(err.cause instanceof ActivityFailure)) {
      t.fail('Expected err.cause to be an instance of ActivityFailure');
      return;
    }
    if (!(err.cause.cause instanceof ApplicationFailure)) {
      t.fail('Expected err.cause.cause to be an instance of ApplicationFailure');
      return;
    }
    t.is(err.cause.cause.message, 'Fail me');
    t.is(
      cleanStackTrace(err.cause.cause.stack),
      dedent`
      Error: Fail me
          at Activity.throwAnError [as fn]
      `
    );
  });

  test('child-workflow-invoke', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.childWorkflowInvoke, { taskQueue: 'test' });
    const { workflowId, runId, execResult, result } = await workflow.execute();
    t.is(execResult, 'success');
    t.is(result, 'success');
    const child = client.createWorkflowHandle(workflowId, runId);
    t.is(await child.result(), 'success');
  });

  test('child-workflow-failure', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.childWorkflowFailure, { taskQueue: 'test' });
    const err: WorkflowExecutionFailedError = await t.throwsAsync(workflow.execute(), {
      instanceOf: WorkflowExecutionFailedError,
    });
    if (!(err.cause instanceof ChildWorkflowFailure)) {
      return t.fail('Expected err.cause to be an instance of ChildWorkflowFailure');
    }
    if (!(err.cause.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.cause.message, 'failure');
    t.is(
      cleanStackTrace(err.cause.cause.stack),
      dedent`
        Error: failure
            at Object.execute
      `
    );
  });

  test('child-workflow-termination', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.childWorkflowTermination, { taskQueue: 'test' });
    await workflow.start();

    let childExecution: WorkflowExecution | undefined = undefined;

    while (childExecution === undefined) {
      childExecution = await workflow.query.childExecution();
    }
    const child = client.createWorkflowHandle(childExecution.workflowId!, childExecution.runId!);
    await child.terminate();
    const err: WorkflowExecutionFailedError = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowExecutionFailedError,
    });
    if (!(err.cause instanceof ChildWorkflowFailure)) {
      return t.fail('Expected err.cause to be an instance of ChildWorkflowFailure');
    }
    t.is(err.cause.retryState, RetryState.RETRY_STATE_NON_RETRYABLE_FAILURE);
    if (!(err.cause.cause instanceof TerminatedFailure)) {
      return t.fail('Expected err.cause.cause to be an instance of TerminatedFailure');
    }
  });

  test('child-workflow-timeout', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.childWorkflowTimeout, { taskQueue: 'test' });
    const err: WorkflowExecutionFailedError = await t.throwsAsync(workflow.execute(), {
      instanceOf: WorkflowExecutionFailedError,
    });
    if (!(err.cause instanceof ChildWorkflowFailure)) {
      return t.fail('Expected err.cause to be an instance of ChildWorkflowFailure');
    }
    t.is(err.cause.retryState, RetryState.RETRY_STATE_TIMEOUT);
    if (!(err.cause.cause instanceof TimeoutFailure)) {
      return t.fail('Expected err.cause.cause to be an instance of TimeoutFailure');
    }
    t.is(err.cause.cause.timeoutType, TimeoutType.TIMEOUT_TYPE_START_TO_CLOSE);
  });

  test('child-workflow-start-fail', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.childWorkflowStartFail, { taskQueue: 'test' });
    await workflow.execute();
    // Assertions in workflow code
    t.pass();
  });

  test('child-workflow-cancel', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.childWorkflowCancel, { taskQueue: 'test' });
    await workflow.execute();
    // Assertions in workflow code
    t.pass();
  });

  test('child-workflow-signals', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.childWorkflowSignals, { taskQueue: 'test' });
    await workflow.execute();
    // Assertions in workflow code
    t.pass();
  });

  test('query and unblock', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.unblockOrCancel, { taskQueue: 'test' });
    await workflow.start();
    t.true(await workflow.query.isBlocked());
    await workflow.signal.unblock();
    await workflow.result();
    t.false(await workflow.query.isBlocked());
  });

  test('interrupt-signal', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.interruptSignal, { taskQueue: 'test' });
    await workflow.start();
    await workflow.signal.interrupt('just because');
    const err: WorkflowExecutionFailedError = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowExecutionFailedError,
    });
    if (!(err.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.message, 'just because');
  });

  test('fail-signal', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.failSignal, { taskQueue: 'test' });
    await workflow.start();
    await workflow.signal.fail();
    const err: WorkflowExecutionFailedError = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowExecutionFailedError,
    });
    if (!(err.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.message, 'Signal failed');
  });

  test('async-fail-signal', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.asyncFailSignal, { taskQueue: 'test' });
    await workflow.start();
    await workflow.signal.fail();
    const err: WorkflowExecutionFailedError = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowExecutionFailedError,
    });
    if (!(err.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.message, 'Signal failed');
  });

  test('http', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.http, { taskQueue: 'test' });
    const res = await workflow.execute();
    t.deepEqual(res, await activities.httpGet('https://temporal.io'));
  });

  test('sleep', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.sleeper, { taskQueue: 'test' });
    const runId = await workflow.start();
    const res = await workflow.result();
    t.is(res, undefined);
    const execution = await client.service.getWorkflowExecutionHistory({
      namespace,
      execution: { workflowId: workflow.workflowId, runId },
    });
    const timerEvents = execution.history!.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
    t.is(timerEvents.length, 2);
    t.is(timerEvents[0].timerStartedEventAttributes!.timerId, '1');
    t.is(tsToMs(timerEvents[0].timerStartedEventAttributes!.startToFireTimeout), 100);
    t.is(timerEvents[1].timerFiredEventAttributes!.timerId, '1');
  });

  test('cancel-timer-immediately', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.cancelTimer, { taskQueue: 'test' });
    const runId = await workflow.start();
    const res = await workflow.result();
    t.is(res, undefined);
    const execution = await client.service.getWorkflowExecutionHistory({
      namespace,
      execution: { workflowId: workflow.workflowId, runId },
    });
    const timerEvents = execution.history!.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
    // Timer is cancelled before it is scheduled
    t.is(timerEvents.length, 0);
  });

  test('cancel-timer-with-delay', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.cancelTimerWithDelay, { taskQueue: 'test' });
    const runId = await workflow.start();
    const res = await workflow.result();
    t.is(res, undefined);
    const execution = await client.service.getWorkflowExecutionHistory({
      namespace,
      execution: { workflowId: workflow.workflowId, runId },
    });
    const timerEvents = execution.history!.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
    t.is(timerEvents.length, 4);
    t.is(timerEvents[0].timerStartedEventAttributes!.timerId, '1');
    t.is(tsToMs(timerEvents[0].timerStartedEventAttributes!.startToFireTimeout), 10000);
    t.is(timerEvents[1].timerStartedEventAttributes!.timerId, '2');
    t.is(tsToMs(timerEvents[1].timerStartedEventAttributes!.startToFireTimeout), 1);
    t.is(timerEvents[2].timerFiredEventAttributes!.timerId, '2');
    t.is(timerEvents[3].timerCanceledEventAttributes!.timerId, '1');
  });

  test('patched', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.patchedWorkflow, { taskQueue: 'test' });
    const runId = await workflow.start();
    const res = await workflow.result();
    t.is(res, undefined);
    const execution = await client.service.getWorkflowExecutionHistory({
      namespace,
      execution: { workflowId: workflow.workflowId, runId },
    });
    const hasChangeEvents = execution.history!.events!.filter(
      ({ eventType }) => eventType === iface.temporal.api.enums.v1.EventType.EVENT_TYPE_MARKER_RECORDED
    );
    // There will only be one marker despite there being 2 hasChange calls because they have the
    // same ID and core will only record one marker per id.
    t.is(hasChangeEvents.length, 1);
    t.is(hasChangeEvents[0].markerRecordedEventAttributes!.markerName, CHANGE_MARKER_NAME);
  });

  test('deprecate-patch', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.deprecatePatchWorkflow, { taskQueue: 'test' });
    const runId = await workflow.start();
    const res = await workflow.result();
    t.is(res, undefined);
    const execution = await client.service.getWorkflowExecutionHistory({
      namespace,
      execution: { workflowId: workflow.workflowId, runId },
    });
    const hasChangeEvents = execution.history!.events!.filter(
      ({ eventType }) => eventType === iface.temporal.api.enums.v1.EventType.EVENT_TYPE_MARKER_RECORDED
    );
    t.is(hasChangeEvents.length, 1);
    t.is(hasChangeEvents[0].markerRecordedEventAttributes!.markerName, CHANGE_MARKER_NAME);
  });

  test('Worker default ServerOptions are generated correctly', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.argsAndReturn, { taskQueue: 'test' });
    const runId = await workflow.start('hey', undefined, Buffer.from('abc'));
    await workflow.result();
    const execution = await client.service.getWorkflowExecutionHistory({
      namespace,
      execution: { workflowId: workflow.workflowId, runId },
    });
    const events = execution.history!.events!.filter(
      ({ eventType }) => eventType === iface.temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_TASK_COMPLETED
    );
    t.is(events.length, 1);
    const [event] = events;
    t.regex(event.workflowTaskCompletedEventAttributes!.identity!, /\d+@.+/);
    t.regex(event.workflowTaskCompletedEventAttributes!.binaryChecksum!, /@temporalio\/worker@\d+\.\d+\.\d+/);
  });

  test('WorkflowOptions are passed correctly with defaults', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.argsAndReturn, { taskQueue: 'test' });
    await workflow.execute('hey', undefined, Buffer.from('def'));
    const execution = await workflow.describe();
    t.deepEqual(
      execution.workflowExecutionInfo?.type,
      new iface.temporal.api.common.v1.WorkflowType({ name: 'argsAndReturn' })
    );
    t.deepEqual(execution.workflowExecutionInfo?.memo, new iface.temporal.api.common.v1.Memo({ fields: {} }));
    t.deepEqual(Object.keys(execution.workflowExecutionInfo!.searchAttributes!.indexedFields!), ['BinaryChecksums']);

    const checksums = await defaultDataConverter.fromPayload(
      execution.workflowExecutionInfo!.searchAttributes!.indexedFields!.BinaryChecksums!
    );
    t.true(checksums instanceof Array && checksums.length === 1);
    t.regex((checksums as string[])[0], /@temporalio\/worker@\d+\.\d+\.\d+/);
    t.is(execution.executionConfig?.taskQueue?.name, 'test');
    t.is(execution.executionConfig?.taskQueue?.kind, iface.temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_NORMAL);
    t.is(execution.executionConfig?.workflowRunTimeout, null);
    t.is(execution.executionConfig?.workflowExecutionTimeout, null);
  });

  test('WorkflowOptions are passed correctly', async (t) => {
    const { client } = t.context;
    const options = {
      taskQueue: 'test2',
      memo: { a: 'b' },
      searchAttributes: { CustomIntField: 3 },
      workflowId: uuid4(),
      workflowRunTimeout: '2s',
      workflowExecutionTimeout: '3s',
      workflowTaskTimeout: '1s',
    };
    const workflow = client.createWorkflowHandle(workflows.sleeper, options);
    // Throws because we use a different task queue
    await t.throwsAsync(() => workflow.execute(), {
      instanceOf: WorkflowExecutionTimedOutError,
      message: 'Workflow execution timed out',
    });
    const execution = await workflow.describe();
    t.deepEqual(
      execution.workflowExecutionInfo?.type,
      new iface.temporal.api.common.v1.WorkflowType({ name: 'sleeper' })
    );
    t.deepEqual(await defaultDataConverter.fromPayload(execution.workflowExecutionInfo!.memo!.fields!.a!), 'b');
    t.deepEqual(
      await defaultDataConverter.fromPayload(
        execution.workflowExecutionInfo!.searchAttributes!.indexedFields!.CustomIntField!
      ),
      3
    );
    t.is(execution.executionConfig?.taskQueue?.name, 'test2');
    t.is(execution.executionConfig?.taskQueue?.kind, iface.temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_NORMAL);

    t.is(tsToMs(execution.executionConfig!.workflowRunTimeout!), ms(options.workflowRunTimeout));
    t.is(tsToMs(execution.executionConfig!.workflowExecutionTimeout!), ms(options.workflowExecutionTimeout));
    t.is(tsToMs(execution.executionConfig!.defaultWorkflowTaskTimeout!), ms(options.workflowTaskTimeout));
  });

  test('WorkflowHandle.result() throws if terminated', async (t) => {
    const { client } = t.context;
    const workflow = client.createWorkflowHandle(workflows.sleeper, { taskQueue: 'test' });
    await workflow.start(1000000);
    await workflow.terminate('hasta la vista baby');
    await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowExecutionTerminatedError,
      message: 'hasta la vista baby',
    });
  });

  test('WorkflowHandle.result() throws if continued as new', async (t) => {
    const { client } = t.context;
    let workflow = client.createWorkflowHandle(workflows.continueAsNewSameWorkflow, {
      taskQueue: 'test',
    });
    let err = await t.throwsAsync(workflow.execute(), { instanceOf: WorkflowExecutionContinuedAsNewError });
    if (!(err instanceof WorkflowExecutionContinuedAsNewError)) return; // Type assertion
    workflow = client.createWorkflowHandle<typeof workflows.continueAsNewSameWorkflow>(
      workflow.workflowId,
      err.newExecutionRunId
    );

    await workflow.signal.continueAsNew();
    err = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowExecutionContinuedAsNewError,
    });
    if (!(err instanceof WorkflowExecutionContinuedAsNewError)) return; // Type assertion

    workflow = client.createWorkflowHandle<typeof workflows.continueAsNewSameWorkflow>(
      workflow.workflowId,
      err.newExecutionRunId
    );
    await workflow.result();
  });

  test('continue-as-new-to-different-workflow', async (t) => {
    const { client } = t.context;
    let workflow = client.createWorkflowHandle(workflows.continueAsNewToDifferentWorkflow, {
      taskQueue: 'test',
    });
    const err = await t.throwsAsync(workflow.execute(), { instanceOf: WorkflowExecutionContinuedAsNewError });
    if (!(err instanceof WorkflowExecutionContinuedAsNewError)) return; // Type assertion
    workflow = client.createWorkflowHandle<typeof workflows.sleeper>(workflow.workflowId, err.newExecutionRunId);
    await workflow.result();
    const info = await workflow.describe();
    t.is(info.workflowExecutionInfo?.type?.name, 'sleeper');
    const { history } = await client.service.getWorkflowExecutionHistory({
      namespace,
      execution: { workflowId: workflow.workflowId, runId: err.newExecutionRunId },
    });
    const timeSlept = await defaultDataConverter.fromPayloads(
      0,
      history?.events?.[0].workflowExecutionStartedEventAttributes?.input?.payloads
    );
    t.is(timeSlept, 1);
  });

  test('signalWithStart works as intended and returns correct runId', async (t) => {
    const { client } = t.context;
    let workflow = client.createWorkflowHandle(workflows.interruptSignal, {
      taskQueue: 'test',
    });
    const runId = await workflow.signalWithStart('interrupt', ['interrupted from signalWithStart'], []);
    {
      const err: WorkflowExecutionFailedError = await t.throwsAsync(workflow.result(), {
        instanceOf: WorkflowExecutionFailedError,
      });
      if (!(err.cause instanceof ApplicationFailure)) {
        return t.fail('Expected err.cause to be an instance of ApplicationFailure');
      }
      t.is(err.cause.message, 'interrupted from signalWithStart');
    }
    // Test returned runId
    workflow = client.createWorkflowHandle<typeof workflows.interruptSignal>(workflow.workflowId, runId);
    {
      const err: WorkflowExecutionFailedError = await t.throwsAsync(workflow.result(), {
        instanceOf: WorkflowExecutionFailedError,
      });
      if (!(err.cause instanceof ApplicationFailure)) {
        return t.fail('Expected err.cause to be an instance of ApplicationFailure');
      }
      t.is(err.cause.message, 'interrupted from signalWithStart');
    }
  });

  test('activity-failures', async (t) => {
    const client = new WorkflowClient();
    await client.execute({ taskQueue: 'test' }, 'activityFailures');
    t.pass();
  });

  test.todo('default retryPolicy is filled in ActivityInfo');
}
