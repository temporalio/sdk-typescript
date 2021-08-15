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
import { Worker, DefaultLogger } from '@temporalio/worker';
import * as iface from '@temporalio/proto';
import {
  WorkflowExecutionContinuedAsNewError,
  WorkflowExecutionFailedError,
  WorkflowExecutionTerminatedError,
  WorkflowExecutionTimedOutError,
  ActivityFailure,
  ApplicationFailure,
} from '@temporalio/client';
import {
  ArgsAndReturn,
  HTTP,
  SimpleQuery,
  Sleeper,
  Empty,
  Interruptable,
  AsyncFailable,
  Failable,
  CancellableHTTPRequest,
  ContinueAsNewFromMainAndSignal,
} from './interfaces';
import { httpGet } from './activities';
import { u8, RUN_INTEGRATION_TESTS, cleanStackTrace } from './helpers';
import { withZeroesHTTPServer } from './zeroes-http-server';

const { EVENT_TYPE_TIMER_STARTED, EVENT_TYPE_TIMER_FIRED, EVENT_TYPE_TIMER_CANCELED } =
  iface.temporal.api.enums.v1.EventType;

const timerEventTypes = new Set([EVENT_TYPE_TIMER_STARTED, EVENT_TYPE_TIMER_FIRED, EVENT_TYPE_TIMER_CANCELED]);

export interface Context {
  worker: Worker;
  runPromise: Promise<void>;
}

const test = anyTest as TestInterface<Context>;
const namespace = 'default';

if (RUN_INTEGRATION_TESTS) {
  test.before(async (t) => {
    const worker = await Worker.create({
      workflowsPath: `${__dirname}/workflows`,
      activitiesPath: `${__dirname}/activities`,
      nodeModulesPath: `${__dirname}/../../../node_modules`,
      logger: new DefaultLogger('DEBUG'),
      taskQueue: 'test',
    });

    const runPromise = worker.run();
    // Catch the error here to avoid unhandled rejection
    runPromise.catch((err) => {
      console.error('Caught error while worker was running', err);
    });
    t.context = { worker, runPromise };
  });
  test.after.always(async (t) => {
    t.context.worker.shutdown();
    await t.context.runPromise;
  });

  test('Workflow not found results in failure', async (t) => {
    const client = new WorkflowClient();
    const promise = client.execute<Empty>({ taskQueue: 'test' }, 'not-found');
    const err: WorkflowExecutionFailedError = await t.throwsAsync(() => promise, {
      instanceOf: WorkflowExecutionFailedError,
    });
    if (!(err.cause instanceof ApplicationFailure)) {
      t.fail('Expected err.cause to be an instance of ApplicationFailure');
      return;
    }
    t.is(err.cause.type, 'ReferenceError');
    t.is(err.cause.originalMessage, "Cannot find module './not-found.js'");
    t.true(err.cause.nonRetryable);
    t.is(
      err.cause.stack,
      "ApplicationFailure: message='Cannot find module './not-found.js'', type='ReferenceError', nonRetryable=true"
    );
  });

  test('args-and-return', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<ArgsAndReturn>('args-and-return', { taskQueue: 'test' });
    const res = await workflow.execute('Hello', undefined, u8('world!'));
    t.is(res, 'Hello, world!');
  });

  test('cancel-fake-progress', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<Empty>('cancel-fake-progress', { taskQueue: 'test' });
    await workflow.execute();
    t.pass();
  });

  test('cancel-http-request', async (t) => {
    await withZeroesHTTPServer(async (port) => {
      const client = new WorkflowClient();
      const url = `http://127.0.0.1:${port}`;
      const workflow = client.stub<CancellableHTTPRequest>('cancel-http-request', { taskQueue: 'test' });
      await workflow.execute(url);
    });
    t.pass();
  });

  test('activity-failure', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<Empty>('activity-failure', { taskQueue: 'test' });
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
    t.is(err.cause.cause.originalMessage, 'Fail me');
    t.is(
      cleanStackTrace(err.cause.cause.stack),
      dedent`
      Error: Fail me
          at Activity.throwAnError [as fn]
      `
    );
  });

  test('child-workflow-invoke', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<{ main(): { workflowId: string; runId: string; execResult: string; result: string } }>(
      'child-workflow-invoke',
      { taskQueue: 'test' }
    );
    const { workflowId, runId, execResult, result } = await workflow.execute();
    t.is(execResult, 'success');
    t.is(result, 'success');
    const child = client.stub(workflowId, runId);
    t.is(await child.result(), 'success');
  });

  test('child-workflow-failure', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<Empty>('child-workflow-failure', { taskQueue: 'test' });
    const err: WorkflowExecutionFailedError = await t.throwsAsync(workflow.execute(), {
      instanceOf: WorkflowExecutionFailedError,
    });
    if (!(err.cause instanceof ChildWorkflowFailure)) {
      return t.fail('Expected err.cause to be an instance of ChildWorkflowFailure');
    }
    if (!(err.cause.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.cause.originalMessage, 'failure');
    t.is(
      cleanStackTrace(err.cause.cause.stack),
      dedent`
        Error: failure
            at Object.main
      `
    );
  });

  test('child-workflow-termination', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<{ main(): void; queries: { childExecution(): WorkflowExecution | undefined } }>(
      'child-workflow-termination',
      { taskQueue: 'test' }
    );
    await workflow.start();

    let childExecution: WorkflowExecution | undefined = undefined;

    while (childExecution === undefined) {
      childExecution = await workflow.query.childExecution();
    }
    const child = client.stub(childExecution.workflowId!, childExecution.runId!);
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
    const client = new WorkflowClient();
    const workflow = client.stub<Empty>('child-workflow-timeout', { taskQueue: 'test' });
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
    const client = new WorkflowClient();
    const workflow = client.stub<Empty>('child-workflow-start-fail', { taskQueue: 'test' });
    await workflow.execute();
    // Assertions in workflow code
    t.pass();
  });

  test('child-workflow-cancel', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<Empty>('child-workflow-cancel', { taskQueue: 'test' });
    await workflow.execute();
    // Assertions in workflow code
    t.pass();
  });

  test('simple-query', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<SimpleQuery>('simple-query', { taskQueue: 'test' });
    await workflow.start();
    t.true(await workflow.query.isBlocked());
    await workflow.signal.unblock();
    await workflow.result();
    t.false(await workflow.query.isBlocked());
  });

  test('interrupt-signal', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<Interruptable>('interrupt-signal', { taskQueue: 'test' });
    await workflow.start();
    await workflow.signal.interrupt('just because');
    const err: WorkflowExecutionFailedError = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowExecutionFailedError,
    });
    if (!(err.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.originalMessage, 'just because');
  });

  test('fail-signal', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<Failable>('fail-signal', { taskQueue: 'test' });
    await workflow.start();
    await workflow.signal.fail();
    const err: WorkflowExecutionFailedError = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowExecutionFailedError,
    });
    if (!(err.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.originalMessage, 'Signal failed');
  });

  test('async-fail-signal', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<AsyncFailable>('async-fail-signal', { taskQueue: 'test' });
    await workflow.start();
    await workflow.signal.fail();
    const err: WorkflowExecutionFailedError = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowExecutionFailedError,
    });
    if (!(err.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.originalMessage, 'Signal failed');
  });

  test('http', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<HTTP>('http', { taskQueue: 'test' });
    const res = await workflow.execute();
    t.deepEqual(res, [await httpGet('https://google.com'), await httpGet('http://example.com')]);
  });

  test('sleep', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<Empty>('sleep', { taskQueue: 'test' });
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
    const client = new WorkflowClient();
    const workflow = client.stub<Empty>('cancel-timer-immediately', { taskQueue: 'test' });
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
    const client = new WorkflowClient();
    const workflow = client.stub('cancel-timer-with-delay', { taskQueue: 'test' });
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

  test('Worker default ServerOptions are generated correctly', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<ArgsAndReturn>('args-and-return', { taskQueue: 'test' });
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
    const client = new WorkflowClient();
    const workflow = client.stub<ArgsAndReturn>('args-and-return', { taskQueue: 'test' });
    await workflow.execute('hey', undefined, Buffer.from('def'));
    const execution = await workflow.describe();
    t.deepEqual(
      execution.workflowExecutionInfo?.type,
      new iface.temporal.api.common.v1.WorkflowType({ name: 'args-and-return' })
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
    const client = new WorkflowClient();
    const options = {
      taskQueue: 'test2',
      memo: { a: 'b' },
      searchAttributes: { CustomIntField: 3 },
      workflowId: uuid4(),
      workflowRunTimeout: '2s',
      workflowExecutionTimeout: '3s',
      workflowTaskTimeout: '1s',
    };
    const workflow = client.stub<Empty>('sleep', options);
    // Throws because we use a different task queue
    await t.throwsAsync(() => workflow.execute(), {
      instanceOf: WorkflowExecutionTimedOutError,
      message: 'Workflow execution timed out',
    });
    const execution = await workflow.describe();
    t.deepEqual(
      execution.workflowExecutionInfo?.type,
      new iface.temporal.api.common.v1.WorkflowType({ name: 'sleep' })
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

  test('WorkflowStub.result() throws if terminated', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<Sleeper>('sleep', { taskQueue: 'test' });
    await workflow.start(1000000);
    await workflow.terminate('hasta la vista baby');
    await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowExecutionTerminatedError,
      message: 'hasta la vista baby',
    });
  });

  test('WorkflowStub.result() throws if continued as new', async (t) => {
    const client = new WorkflowClient();
    let workflow = client.stub<ContinueAsNewFromMainAndSignal>('continue-as-new-same-workflow', {
      taskQueue: 'test',
    });
    let err = await t.throwsAsync(workflow.execute(), { instanceOf: WorkflowExecutionContinuedAsNewError });
    if (!(err instanceof WorkflowExecutionContinuedAsNewError)) return; // Type assertion
    workflow = client.stub<ContinueAsNewFromMainAndSignal>(workflow.workflowId, err.newExecutionRunId);

    await workflow.signal.continueAsNew();
    err = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowExecutionContinuedAsNewError,
    });
    if (!(err instanceof WorkflowExecutionContinuedAsNewError)) return; // Type assertion

    workflow = client.stub<ContinueAsNewFromMainAndSignal>(workflow.workflowId, err.newExecutionRunId);
    await workflow.result();
  });

  test('continue-as-new-to-different-workflow', async (t) => {
    const client = new WorkflowClient();
    let workflow = client.stub<Empty>('continue-as-new-to-different-workflow', {
      taskQueue: 'test',
    });
    const err = await t.throwsAsync(workflow.execute(), { instanceOf: WorkflowExecutionContinuedAsNewError });
    if (!(err instanceof WorkflowExecutionContinuedAsNewError)) return; // Type assertion
    workflow = client.stub<Sleeper>(workflow.workflowId, err.newExecutionRunId);
    await workflow.result();
    const info = await workflow.describe();
    t.is(info.workflowExecutionInfo?.type?.name, 'sleep');
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
    const client = new WorkflowClient();
    let workflow = client.stub<Interruptable>('interrupt-signal', {
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
      t.is(err.cause.originalMessage, 'interrupted from signalWithStart');
    }
    // Test returned runId
    workflow = client.stub<Interruptable>(workflow.workflowId, runId);
    {
      const err: WorkflowExecutionFailedError = await t.throwsAsync(workflow.result(), {
        instanceOf: WorkflowExecutionFailedError,
      });
      if (!(err.cause instanceof ApplicationFailure)) {
        return t.fail('Expected err.cause to be an instance of ApplicationFailure');
      }
      t.is(err.cause.originalMessage, 'interrupted from signalWithStart');
    }
  });

  test('activity-failures', async (t) => {
    const client = new WorkflowClient();
    await client.execute({ taskQueue: 'test' }, 'activity-failures');
    t.pass();
  });

  test.todo('default retryPolicy is filled in ActivityInfo');
}
