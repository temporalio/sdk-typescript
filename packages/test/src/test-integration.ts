/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Connection, compileWorkflowOptions, addDefaults } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { ArgsAndReturn } from '../../test-interfaces/lib';
import * as iface from '@temporalio/proto';
import { WorkflowExecutionFailedError } from '@temporalio/workflow/commonjs/errors';
import { defaultDataConverter } from '@temporalio/workflow/commonjs/converter/data-converter';
import { u8, RUN_INTEGRATION_TESTS } from './helpers';
import { tsToMs } from '@temporalio/workflow/commonjs/time';

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
    const opts = compileWorkflowOptions(addDefaults({ taskQueue: 'test' }));
    const runId = await client.startWorkflowExecution(opts, 'not-found');
    const err = await t.throwsAsync(() => client.untilComplete(opts.workflowId, runId));
    t.true(err instanceof WorkflowExecutionFailedError);
    t.regex(err.message, /^Could not find file: \S+\/not-found.js$/);
  });

  test('args-and-return', async (t) => {
    const client = new Connection();
    const workflow = client.workflow<ArgsAndReturn>('args-and-return', { taskQueue: 'test' });
    const res = await workflow('Hello', undefined, u8('world!'));
    t.is(res, 'Hello, world!');
  });

  test('set-timeout', async (t) => {
    const client = new Connection();
    const opts = compileWorkflowOptions(addDefaults({ taskQueue: 'test' }));
    const runId = await client.startWorkflowExecution(opts, 'set-timeout');
    const res = await client.untilComplete(opts.workflowId, runId);
    t.is(res, undefined);
    const execution = await client.service.getWorkflowExecutionHistory({
      namespace: client.options.namespace,
      execution: { workflowId: opts.workflowId, runId },
    });
    const timerEvents = execution.history!.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
    t.is(timerEvents.length, 2);
    t.is(timerEvents[0].timerStartedEventAttributes!.timerId, '0');
    t.is(tsToMs(timerEvents[0].timerStartedEventAttributes!.startToFireTimeout), 100);
    t.is(timerEvents[1].timerFiredEventAttributes!.timerId, '0');
  });

  test('cancel-timer-immediately', async (t) => {
    const client = new Connection();
    const opts = compileWorkflowOptions(addDefaults({ taskQueue: 'test' }));
    const runId = await client.startWorkflowExecution(opts, 'cancel-timer-immediately');
    const res = await client.untilComplete(opts.workflowId, runId);
    t.is(res, undefined);
    const execution = await client.service.getWorkflowExecutionHistory({
      namespace: client.options.namespace,
      execution: { workflowId: opts.workflowId, runId },
    });
    const timerEvents = execution.history!.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
    // Timer is cancelled before it is scheduled
    t.is(timerEvents.length, 0);
  });

  test('cancel-timer-with-delay', async (t) => {
    const client = new Connection();
    const opts = compileWorkflowOptions(addDefaults({ taskQueue: 'test' }));
    const runId = await client.startWorkflowExecution(opts, 'cancel-timer-with-delay');
    const res = await client.untilComplete(opts.workflowId, runId);
    t.is(res, undefined);
    const execution = await client.service.getWorkflowExecutionHistory({
      namespace: client.options.namespace,
      execution: { workflowId: opts.workflowId, runId },
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
    const opts = compileWorkflowOptions(addDefaults({ taskQueue: 'test' }));
    const runId = await client.startWorkflowExecution(opts, 'args-and-return');
    await client.untilComplete(opts.workflowId, runId);
    const execution = await client.service.getWorkflowExecutionHistory({
      namespace: client.options.namespace,
      execution: { workflowId: opts.workflowId, runId },
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
    const opts = compileWorkflowOptions(addDefaults({ taskQueue: 'test' }));
    const runId = await client.startWorkflowExecution(opts, 'args-and-return');
    const execution = await client.service.describeWorkflowExecution({
      namespace: client.options.namespace,
      execution: { runId, workflowId: opts.workflowId },
    });
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
    const opts = compileWorkflowOptions(
      addDefaults({
        taskQueue: 'test2',
        memo: { a: 'b' },
        searchAttributes: { CustomIntField: 3 },
        workflowId: uuid4(),
        workflowRunTimeout: '1s',
        workflowExecutionTimeout: '2s',
        workflowTaskTimeout: '3s',
      })
    );
    const runId = await client.startWorkflowExecution(opts, 'set-timeout');
    const execution = await client.service.describeWorkflowExecution({
      namespace: client.options.namespace,
      execution: { runId, workflowId: opts.workflowId },
    });
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
