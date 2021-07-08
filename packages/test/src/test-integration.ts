/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import anyTest, { TestInterface } from 'ava';
import ms from 'ms';
import { v4 as uuid4 } from 'uuid';
import { WorkflowClient } from '@temporalio/client';
import { tsToMs } from '@temporalio/workflow/lib/time';
import { Worker, DefaultLogger } from '@temporalio/worker';
import * as iface from '@temporalio/proto';
import {
  WorkflowExecutionFailedError,
  WorkflowExecutionTerminatedError,
  WorkflowExecutionTimedOutError,
} from '@temporalio/workflow/lib/errors';
import { defaultDataConverter } from '@temporalio/workflow/lib/converter/data-converter';
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
} from './interfaces';
import { httpGet } from './activities';
import { u8, RUN_INTEGRATION_TESTS } from './helpers';
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
    await t.throwsAsync(() => promise, {
      message: "Cannot find module './not-found.js'",
      instanceOf: WorkflowExecutionFailedError,
    });
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

  test("cancel-http-request don't waitForActivityCancelled", async (t) => {
    await withZeroesHTTPServer(async (port, finished) => {
      const client = new WorkflowClient();
      const url = `http://127.0.0.1:${port}`;
      const workflow = client.stub<CancellableHTTPRequest>('cancel-http-request', { taskQueue: 'test' });
      await t.throwsAsync(() => workflow.execute(url, false), {
        message: 'Activity cancelled',
        instanceOf: WorkflowExecutionFailedError,
      });
      await finished;
    });
  });

  test('activity-failure', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<Empty>('activity-failure', { taskQueue: 'test' });
    await t.throwsAsync(workflow.execute(), { message: 'Fail me', instanceOf: WorkflowExecutionFailedError });
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
    await t.throwsAsync(workflow.result(), { message: /just because/, instanceOf: WorkflowExecutionFailedError });
  });

  test('fail-signal', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<Failable>('fail-signal', { taskQueue: 'test' });
    await workflow.start();
    await workflow.signal.fail();
    await t.throwsAsync(workflow.result(), { message: /Signal failed/, instanceOf: WorkflowExecutionFailedError });
  });

  test('async-fail-signal', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<AsyncFailable>('async-fail-signal', { taskQueue: 'test' });
    await workflow.start();
    await workflow.signal.fail();
    await t.throwsAsync(workflow.result(), { message: /Signal failed/, instanceOf: WorkflowExecutionFailedError });
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
    t.is(timerEvents[0].timerStartedEventAttributes!.timerId, '0');
    t.is(tsToMs(timerEvents[0].timerStartedEventAttributes!.startToFireTimeout), 100);
    t.is(timerEvents[1].timerFiredEventAttributes!.timerId, '0');
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
    t.is(timerEvents[0].timerStartedEventAttributes!.timerId, '0');
    t.is(tsToMs(timerEvents[0].timerStartedEventAttributes!.startToFireTimeout), 10000);
    t.is(timerEvents[1].timerStartedEventAttributes!.timerId, '1');
    t.is(tsToMs(timerEvents[1].timerStartedEventAttributes!.startToFireTimeout), 1);
    t.is(timerEvents[2].timerFiredEventAttributes!.timerId, '1');
    t.is(timerEvents[3].timerCanceledEventAttributes!.timerId, '0');
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
      iface.temporal.api.common.v1.WorkflowType.create({ name: 'args-and-return' })
    );
    t.deepEqual(execution.workflowExecutionInfo?.memo, iface.temporal.api.common.v1.Memo.create({ fields: {} }));
    t.deepEqual(Object.keys(execution.workflowExecutionInfo!.searchAttributes!.indexedFields!), ['BinaryChecksums']);

    const checksums = defaultDataConverter.fromPayload(
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
      iface.temporal.api.common.v1.WorkflowType.create({ name: 'sleep' })
    );
    t.deepEqual(defaultDataConverter.fromPayload(execution.workflowExecutionInfo!.memo!.fields!.a!), 'b');
    t.deepEqual(
      defaultDataConverter.fromPayload(
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

  test('untilComplete throws if terminated', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<Sleeper>('sleep', { taskQueue: 'test' });
    await workflow.start(1000000);
    await workflow.terminate('hasta la vista baby');
    await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowExecutionTerminatedError,
      message: 'hasta la vista baby',
    });
  });

  test.skip('untilComplete throws if workflow cancelled', async (t) => {
    const client = new WorkflowClient();
    const workflow = client.stub<Sleeper>('sleep', { taskQueue: 'test' });
    await workflow.start(1000000);
    await workflow.cancel();
    await t.throwsAsync(workflow.result(), { instanceOf: WorkflowExecutionTerminatedError, message: 'check 1 2' });
  });

  test.todo('untilComplete throws if continued as new');
}
