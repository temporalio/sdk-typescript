/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Connection } from '@temporalio/client';
import { tsToMs } from '@temporalio/workflow/commonjs/time';
import { Worker, DefaultLogger } from '@temporalio/worker';
import * as iface from '@temporalio/proto';
import { WorkflowExecutionFailedError } from '@temporalio/workflow/commonjs/errors';
import { defaultDataConverter } from '@temporalio/workflow/commonjs/converter/data-converter';
import { ArgsAndReturn, HTTP, SimpleQuery, Empty } from '../../test-interfaces/lib';
import { httpGet } from '../../test-activities/lib';
import { u8, RUN_INTEGRATION_TESTS } from './helpers';

const {
  EVENT_TYPE_TIMER_STARTED,
  EVENT_TYPE_TIMER_FIRED,
  EVENT_TYPE_TIMER_CANCELED,
} = iface.temporal.api.enums.v1.EventType;

const timerEventTypes = new Set([EVENT_TYPE_TIMER_STARTED, EVENT_TYPE_TIMER_FIRED, EVENT_TYPE_TIMER_CANCELED]);

if (RUN_INTEGRATION_TESTS) {
  const worker = new Worker(__dirname, {
    workflowsPath: `${__dirname}/../../test-workflows/lib`,
    activitiesPath: `${__dirname}/../../test-activities/lib`,
    logger: new DefaultLogger('DEBUG'),
  });

  test.before((t) => {
    worker.run('test').catch((err) => {
      console.error(err);
      t.fail(`Failed to run worker: ${err}`);
    });
  });
  test.after.always(() => {
    worker.shutdown();
  });

  test('Workflow not found results in failure', async (t) => {
    const client = new Connection();
    const workflow = client.workflow<Empty>('not-found', { taskQueue: 'test' });
    const err = await t.throwsAsync(workflow);
    t.true(err instanceof WorkflowExecutionFailedError);
    t.regex(err.message, /^Could not find file: \S+\/not-found.js$/);
  });

  test('args-and-return', async (t) => {
    const client = new Connection();
    const workflow = client.workflow<ArgsAndReturn>('args-and-return', { taskQueue: 'test' });
    const res = await workflow('Hello', undefined, u8('world!'));
    t.is(res, 'Hello, world!');
  });

  test('simple-query', async (t) => {
    const client = new Connection();
    const workflow = client.workflow<SimpleQuery>('simple-query', { taskQueue: 'test' });
    const res = await workflow();
    await workflow.query.hasSlept();
    t.is(res, undefined);
  });

  // Activities not yet properly implemented
  test.skip('http', async (t) => {
    const client = new Connection();
    const workflow = client.workflow<HTTP>('http', { taskQueue: 'test' });
    const res = await workflow();
    t.is(res, [await httpGet('https://google.com'), await httpGet('http://example.com')]);
  });

  test('set-timeout', async (t) => {
    const client = new Connection();
    const workflow = client.workflow<Empty>('set-timeout', { taskQueue: 'test' });
    const res = await workflow();
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
    const res = await workflow();
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
    const res = await workflow();
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
    await workflow('hey', undefined, Buffer.from('abc'));
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
    await workflow('hey', undefined, Buffer.from('def'));
    const execution = await workflow.describe();
    t.deepEqual(
      execution.workflowExecutionInfo?.type,
      iface.temporal.api.common.v1.WorkflowType.create({ name: 'args-and-return' })
    );
    t.deepEqual(execution.workflowExecutionInfo?.memo, iface.temporal.api.common.v1.Memo.create({ fields: {} }));
    t.deepEqual(
      execution.workflowExecutionInfo?.searchAttributes,
      iface.temporal.api.common.v1.SearchAttributes.create({})
    );
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
      workflowRunTimeout: '1s',
      workflowExecutionTimeout: '2s',
      workflowTaskTimeout: '3s',
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
    // TODO: convert Duraton with Long to number and test these
    // t.is(execution.executionConfig?.workflowRunTimeout, opts.workflowRunTimeout);
    // t.is(execution.executionConfig?.workflowExecutionTimeout, opts.workflowExecutionTimeout);
    // t.is(execution.executionConfig?.defaultWorkflowTaskTimeout, opts.workflowTaskTimeout);
  });

  test.todo('untilComplete throws if workflow cancelled');
  test.todo('untilComplete throws if terminated');
  test.todo('untilComplete throws if timed out');
  test.todo('untilComplete throws if continued as new');
}
