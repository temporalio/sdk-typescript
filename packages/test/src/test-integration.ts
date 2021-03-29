/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import anyTest, { TestInterface, ExecutionContext } from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Connection } from '@temporalio/client';
import { tsToMs } from '@temporalio/workflow/commonjs/time';
import { Worker, DefaultLogger } from '@temporalio/worker';
import * as iface from '@temporalio/proto';
import {
  WorkflowExecutionFailedError,
  WorkflowExecutionTimedOutError,
  WorkflowExecutionTerminatedError,
} from '@temporalio/workflow/commonjs/errors';
import { defaultDataConverter } from '@temporalio/workflow/commonjs/converter/data-converter';
import { ArgsAndReturn, HTTP, SimpleQuery, SetTimeout, Empty, Interruptable } from '../../test-interfaces/lib';
import { httpGet } from '../../test-activities/lib';
import { u8, RUN_INTEGRATION_TESTS } from './helpers';

const {
  EVENT_TYPE_TIMER_STARTED,
  EVENT_TYPE_TIMER_FIRED,
  EVENT_TYPE_TIMER_CANCELED,
} = iface.temporal.api.enums.v1.EventType;

const timerEventTypes = new Set([EVENT_TYPE_TIMER_STARTED, EVENT_TYPE_TIMER_FIRED, EVENT_TYPE_TIMER_CANCELED]);

export interface Context {
  worker: Worker;
}

const test = anyTest as TestInterface<Context>;

if (RUN_INTEGRATION_TESTS) {
  test.before(async (t) => {
    const worker = await Worker.create(__dirname, {
      workflowsPath: `${__dirname}/../../test-workflows/lib`,
      activitiesPath: `${__dirname}/../../test-activities/lib`,
      logger: new DefaultLogger('DEBUG'),
    });
    t.context = { worker };

    worker.run('test').catch((err) => {
      console.error(err);
      t.fail(`Failed to run worker: ${err}`);
    });
  });
  test.after.always((t) => {
    t.context.worker.shutdown();
  });

  test('Workflow not found results in failure', async (t) => {
    const client = new Connection();
    const workflow = client.workflow<Empty>('not-found', { taskQueue: 'test' });
    await t.throwsAsync(() => workflow.start(), {
      message: /^Could not find file: \S+\/not-found.js$/,
      instanceOf: WorkflowExecutionFailedError,
    });
  });

  test('args-and-return', async (t) => {
    const client = new Connection();
    const workflow = client.workflow<ArgsAndReturn>('args-and-return', { taskQueue: 'test' });
    const res = await workflow.start('Hello', undefined, u8('world!'));
    t.is(res, 'Hello, world!');
  });

  // Queries not yet properly implemented
  test.skip('simple-query', async (t) => {
    const client = new Connection();
    const workflow = client.workflow<SimpleQuery>('simple-query', { taskQueue: 'test' });
    const res = await workflow.start();
    await workflow.query.hasSlept();
    t.is(res, undefined);
  });

  // Queries not yet properly implemented
  test.skip('signals', async (t) => {
    const client = new Connection();
    const workflow = client.workflow<Interruptable>('signals', { taskQueue: 'test' });
    const promise = workflow.start();
    await workflow.started;
    await workflow.signal.interrupt('just because');
    t.throwsAsync(promise, { message: /just because/, instanceOf: WorkflowExecutionFailedError });
  });

  // Activities not yet properly implemented
  test.skip('http', async (t) => {
    const client = new Connection();
    const workflow = client.workflow<HTTP>('http', { taskQueue: 'test' });
    const res = await workflow.start();
    t.is(res, [await httpGet('https://google.com'), await httpGet('http://example.com')]);
  });

  test('set-timeout', async (t) => {
    const client = new Connection();
    const workflow = client.workflow<Empty>('set-timeout', { taskQueue: 'test' });
    const res = await workflow.start();
    t.is(res, undefined);
    const execution = await client.service.getWorkflowExecutionHistory({
      namespace: client.options.namespace,
      execution: { workflowId: workflow.workflowId, runId: workflow.runId },
    });
    const timerEvents = execution.history!.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
    t.is(timerEvents.length, 2);
    t.is(timerEvents[0].timerStartedEventAttributes!.timerId, '0');
    t.is(tsToMs(timerEvents[0].timerStartedEventAttributes!.startToFireTimeout), 100);
    t.is(timerEvents[1].timerFiredEventAttributes!.timerId, '0');
  });

  test('cancel-timer-immediately', async (t) => {
    const client = new Connection();
    const workflow = client.workflow<Empty>('cancel-timer-immediately', { taskQueue: 'test' });
    const res = await workflow.start();
    t.is(res, undefined);
    const execution = await client.service.getWorkflowExecutionHistory({
      namespace: client.options.namespace,
      execution: { workflowId: workflow.workflowId, runId: workflow.runId },
    });
    const timerEvents = execution.history!.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
    // Timer is cancelled before it is scheduled
    t.is(timerEvents.length, 0);
  });

  test('cancel-timer-with-delay', async (t) => {
    const client = new Connection();
    const workflow = client.workflow('cancel-timer-with-delay', { taskQueue: 'test' });
    const res = await workflow.start();
    t.is(res, undefined);
    const execution = await client.service.getWorkflowExecutionHistory({
      namespace: client.options.namespace,
      execution: { workflowId: workflow.workflowId, runId: workflow.runId },
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
    const client = new Connection();
    const workflow = client.workflow<ArgsAndReturn>('args-and-return', { taskQueue: 'test' });
    await workflow.start('hey', undefined, Buffer.from('abc'));
    const execution = await client.service.getWorkflowExecutionHistory({
      namespace: client.options.namespace,
      execution: { workflowId: workflow.workflowId, runId: workflow.runId },
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
    const client = new Connection();
    const workflow = client.workflow<ArgsAndReturn>('args-and-return', { taskQueue: 'test' });
    await workflow.start('hey', undefined, Buffer.from('def'));
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
    const client = new Connection();
    const workflow = client.workflow<Empty>('set-timeout', {
      taskQueue: 'test2',
      memo: { a: 'b' },
      searchAttributes: { CustomIntField: 3 },
      workflowId: uuid4(),
      workflowRunTimeout: '2s',
      workflowExecutionTimeout: '3s',
      workflowTaskTimeout: '1s',
    });
    // Throws because we use a different task queue
    await t.throwsAsync(() => workflow.start(), {
      instanceOf: WorkflowExecutionTimedOutError,
      message: 'Workflow execution timed out',
    });
    const execution = await workflow.describe();
    t.deepEqual(
      execution.workflowExecutionInfo?.type,
      iface.temporal.api.common.v1.WorkflowType.create({ name: 'set-timeout' })
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

    t.is(
      durationToMs(execution.executionConfig!.workflowRunTimeout!),
      tsToMs(workflow.compiledOptions.workflowRunTimeout)
    );
    t.is(
      durationToMs(execution.executionConfig!.workflowExecutionTimeout!),
      tsToMs(workflow.compiledOptions.workflowExecutionTimeout)
    );
    t.is(
      durationToMs(execution.executionConfig!.defaultWorkflowTaskTimeout!),
      tsToMs(workflow.compiledOptions.workflowTaskTimeout)
    );
  });

  test('untilComplete throws if terminated', async (t) => {
    const client = new Connection();
    const workflow = client.workflow<SetTimeout>('set-timeout', { taskQueue: 'test' });
    const promise = workflow.start(1000000);
    await workflow.started;
    await workflow.terminate('hasta la vista baby');
    await t.throwsAsync(promise, { instanceOf: WorkflowExecutionTerminatedError, message: 'hasta la vista baby' });
  });

  test.skip('untilComplete throws if workflow cancelled', async (t) => {
    const client = new Connection();
    const workflow = client.workflow<SetTimeout>('set-timeout', { taskQueue: 'test' });
    const promise = workflow.start(1000000);
    await workflow.started;
    await workflow.cancel();
    await t.throwsAsync(promise, { instanceOf: WorkflowExecutionTerminatedError, message: 'check 1 2' });
  });

  test.todo('untilComplete throws if continued as new');
}

function durationToMs(duration: iface.google.protobuf.IDuration) {
  // The client returns Longs instead of numbers from the client ignoring the generated proto instructions (--force-number)
  return tsToMs(
    iface.google.protobuf.Duration.toObject(iface.google.protobuf.Duration.create(duration), { longs: Number })
  );
}
