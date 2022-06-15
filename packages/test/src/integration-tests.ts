/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import {
  ActivityFailure,
  ApplicationFailure,
  Connection,
  WorkflowClient,
  WorkflowContinuedAsNewError,
  WorkflowFailedError,
} from '@temporalio/client';
import {
  ChildWorkflowFailure,
  defaultPayloadConverter,
  Payload,
  PayloadCodec,
  RetryState,
  searchAttributePayloadConverter,
  TerminatedFailure,
  TimeoutFailure,
  TimeoutType,
  WorkflowExecution,
} from '@temporalio/common';
import { decode, decodeFromPayloadsAtIndex, loadDataConverter } from '@temporalio/internal-non-workflow-common';
import {
  tsToMs,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from '@temporalio/internal-workflow-common';
import * as iface from '@temporalio/proto';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import pkg from '@temporalio/worker/lib/pkg';
import * as grpc from '@grpc/grpc-js';
import v8 from 'v8';
import asyncRetry from 'async-retry';
import anyTest, { Implementation, TestInterface } from 'ava';
import dedent from 'dedent';
import ms from 'ms';
import { v4 as uuid4 } from 'uuid';
import * as activities from './activities';
import { ConnectionInjectorInterceptor } from './activities/interceptors';
import { cleanOptionalStackTrace, u8 } from './helpers';
import * as workflows from './workflows';
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

const _test = anyTest as TestInterface<Context>;
const namespace = 'default';

export function runIntegrationTests(codec?: PayloadCodec): void {
  const test = (name: string, fn: Implementation<Context>) => _test(codec ? 'With codec—' + name : name, fn);
  const dataConverter = { payloadCodecs: codec ? [codec] : [] };
  const loadedDataConverter = { payloadConverter: defaultPayloadConverter, payloadCodecs: codec ? [codec] : [] };
  async function fromPayload(payload: Payload) {
    const [decodedPayload] = await decode(dataConverter.payloadCodecs, [payload]);
    return defaultPayloadConverter.fromPayload(decodedPayload);
  }

  _test.before(async (t) => {
    const logger = new DefaultLogger('DEBUG');
    // Use forwarded logging from core
    Runtime.install({ logger, telemetryOptions: { logging: { forward: { level: 'INFO' } } } });
    const connection = await Connection.connect();

    const worker = await Worker.create({
      workflowsPath: require.resolve('./workflows'),
      activities,
      taskQueue: 'test',
      dataConverter,
      interceptors: {
        activityInbound: [() => new ConnectionInjectorInterceptor(connection, loadDataConverter(dataConverter))],
      },
    });

    const runPromise = worker.run();
    // Catch the error here to avoid unhandled rejection
    runPromise.catch((err) => {
      console.error('Caught error while worker was running', err);
    });
    t.context = {
      worker,
      runPromise,
      client: new WorkflowClient({ connection, dataConverter }),
    };

    // In case we're running with temporalite or other non default server.
    // NOTE: at the time this was added temporalite did not expose the grpc OperatorService.
    try {
      await connection.operatorService.addSearchAttributes({
        searchAttributes: {
          CustomIntField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_INT,
          CustomBoolField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_BOOL,
          CustomKeywordField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
          CustomTextField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_TEXT,
          CustomDatetimeField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_DATETIME,
          CustomDoubleField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_DOUBLE,
        },
      });
    } catch (err: any) {
      if (err.code !== grpc.status.ALREADY_EXISTS) {
        throw err;
      }
    }
    // The initialization of the custom search attributes is slooooow. Wait for it to finish
    await asyncRetry(
      async () => {
        try {
          const handle = await t.context.client.start(workflows.sleeper, {
            workflowId: uuid4(),
            taskQueue: 'no_one_cares_pointless_queue',
            workflowExecutionTimeout: 1000,
            searchAttributes: { CustomIntField: [1] },
          });
          await handle.terminate();
        } catch (e: any) {
          // We don't stop until we see an error that *isn't* the error about the field not being
          // valid
          if (!e.details.includes('CustomIntField')) {
            return;
          }
          throw e;
        }
      },
      {
        retries: 60,
        maxTimeout: 1000,
      }
    );
  });

  _test.after.always(async (t) => {
    t.context.worker.shutdown();
    await t.context.runPromise;
  });

  test('Workflow not found results in task retry', async (t) => {
    const { client } = t.context;
    const handle = await client.start('not-found', {
      taskQueue: 'test',
      workflowId: uuid4(),
    });

    try {
      await asyncRetry(
        async () => {
          const { history } = await client.workflowService.getWorkflowExecutionHistory({
            namespace: 'default',
            execution: { workflowId: handle.workflowId },
          });
          if (
            !history?.events?.some(
              ({ workflowTaskFailedEventAttributes }) =>
                workflowTaskFailedEventAttributes?.failure?.message === "'not-found' is not a function"
            )
          ) {
            throw new Error('Cannot find workflow task failed event');
          }
        },
        {
          retries: 60,
          maxTimeout: 1000,
        }
      );
    } finally {
      await handle.terminate();
    }
    t.pass();
  });

  test('args-and-return', async (t) => {
    const { client } = t.context;
    const res = await client.execute(workflows.argsAndReturn, {
      taskQueue: 'test',
      workflowId: uuid4(),
      args: ['Hello', undefined, u8('world!')],
    });
    t.is(res, 'Hello, world!');
  });

  test('cancel-fake-progress', async (t) => {
    const { client } = t.context;
    await client.execute(workflows.cancelFakeProgress, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    t.pass();
  });

  test('cancel-http-request', async (t) => {
    const { client } = t.context;
    await withZeroesHTTPServer(async (port) => {
      const url = `http://127.0.0.1:${port}`;
      await client.execute(workflows.cancellableHTTPRequest, {
        taskQueue: 'test',
        workflowId: uuid4(),
        args: [url],
      });
    });
    t.pass();
  });

  test('activity-failure with Error', async (t) => {
    const { client } = t.context;
    const err: WorkflowFailedError = await t.throwsAsync(
      client.execute(workflows.activityFailure, {
        taskQueue: 'test',
        workflowId: uuid4(),
        args: [{ useApplicationFailure: false }],
      }),
      {
        instanceOf: WorkflowFailedError,
      }
    );
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
      cleanOptionalStackTrace(err.cause.cause.stack),
      dedent`
    Error: Fail me
        at Activity.throwAnError [as fn] (test/src/activities/index.ts)
    `
    );
  });

  test('activity-failure with ApplicationFailure', async (t) => {
    const { client } = t.context;
    const err: WorkflowFailedError = await t.throwsAsync(
      client.execute(workflows.activityFailure, {
        taskQueue: 'test',
        workflowId: uuid4(),
        args: [{ useApplicationFailure: true }],
      }),
      {
        instanceOf: WorkflowFailedError,
      }
    );
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
    t.is(err.cause.cause.type, 'Error');
    t.deepEqual(err.cause.cause.details, ['details', 123, false]);
    t.is(
      cleanOptionalStackTrace(err.cause.cause.stack),
      dedent`
    ApplicationFailure: Fail me
        at Function.nonRetryable (common/src/failure.ts)
        at Activity.throwAnError [as fn] (test/src/activities/index.ts)
    `
    );
  });

  test('child-workflow-invoke', async (t) => {
    const { client } = t.context;
    const workflow = await client.start(workflows.childWorkflowInvoke, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    const { workflowId, runId, execResult, result } = await workflow.result();
    t.is(execResult, 'success');
    t.is(result, 'success');
    const child = client.getHandle(workflowId, runId);
    t.is(await child.result(), 'success');
  });

  test('child-workflow-failure', async (t) => {
    const { client } = t.context;
    const err: WorkflowFailedError = await t.throwsAsync(
      client.execute(workflows.childWorkflowFailure, {
        taskQueue: 'test',
        workflowId: uuid4(),
      }),
      {
        instanceOf: WorkflowFailedError,
      }
    );
    if (!(err.cause instanceof ChildWorkflowFailure)) {
      return t.fail('Expected err.cause to be an instance of ChildWorkflowFailure');
    }
    if (!(err.cause.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.cause.message, 'failure');
    t.is(
      cleanOptionalStackTrace(err.cause.cause.stack),
      dedent`
      ApplicationFailure: failure
          at Function.nonRetryable (common/src/failure.ts)
          at throwAsync (test/src/workflows/throw-async.ts)
    `
    );
  });

  test('child-workflow-termination', async (t) => {
    const { client } = t.context;
    const workflow = await client.start(workflows.childWorkflowTermination, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });

    let childExecution: WorkflowExecution | undefined = undefined;

    while (childExecution === undefined) {
      childExecution = await workflow.query(workflows.childExecutionQuery);
    }
    const child = client.getHandle(childExecution.workflowId!, childExecution.runId!);
    await child.terminate();
    const err: WorkflowFailedError = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowFailedError,
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
    const err: WorkflowFailedError = await t.throwsAsync(
      client.execute(workflows.childWorkflowTimeout, {
        taskQueue: 'test',
        workflowId: uuid4(),
      }),
      {
        instanceOf: WorkflowFailedError,
      }
    );
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
    await client.execute(workflows.childWorkflowStartFail, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    // Assertions in workflow code
    t.pass();
  });

  test('child-workflow-cancel', async (t) => {
    const { client } = t.context;
    await client.execute(workflows.childWorkflowCancel, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    // Assertions in workflow code
    t.pass();
  });

  test('child-workflow-signals', async (t) => {
    const { client } = t.context;
    await client.execute(workflows.childWorkflowSignals, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    // Assertions in workflow code
    t.pass();
  });

  test('query and unblock', async (t) => {
    const { client } = t.context;
    const workflow = await client.start(workflows.unblockOrCancel, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    t.true(await workflow.query(workflows.isBlockedQuery));
    await workflow.signal(workflows.unblockSignal);
    await workflow.result();
    t.false(await workflow.query(workflows.isBlockedQuery));
  });

  test('interrupt-signal', async (t) => {
    const { client } = t.context;
    const workflow = await client.start(workflows.interruptableWorkflow, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    await workflow.signal(workflows.interruptSignal, 'just because');
    const err: WorkflowFailedError = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowFailedError,
    });
    if (!(err.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.message, 'just because');
  });

  test('fail-signal', async (t) => {
    const { client } = t.context;
    const workflow = await client.start(workflows.failSignalWorkflow, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    await workflow.signal(workflows.failSignal);
    const err: WorkflowFailedError = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowFailedError,
    });
    if (!(err.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.message, 'Signal failed');
  });

  test('async-fail-signal', async (t) => {
    const { client } = t.context;
    const workflow = await client.start(workflows.asyncFailSignalWorkflow, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    await workflow.signal(workflows.failSignal);
    const err: WorkflowFailedError = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowFailedError,
    });
    if (!(err.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.message, 'Signal failed');
  });

  test('http', async (t) => {
    const { client } = t.context;
    const res = await client.execute(workflows.http, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    t.deepEqual(res, await activities.httpGet('https://temporal.io'));
  });

  test('sleep', async (t) => {
    const { client } = t.context;
    const workflow = await client.start(workflows.sleeper, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    const res = await workflow.result();
    t.is(res, undefined);
    const execution = await client.workflowService.getWorkflowExecutionHistory({
      namespace,
      execution: { workflowId: workflow.workflowId, runId: workflow.firstExecutionRunId },
    });
    const timerEvents = execution.history!.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
    t.is(timerEvents.length, 2);
    t.is(timerEvents[0].timerStartedEventAttributes!.timerId, '1');
    t.is(tsToMs(timerEvents[0].timerStartedEventAttributes!.startToFireTimeout), 100);
    t.is(timerEvents[1].timerFiredEventAttributes!.timerId, '1');
  });

  test('cancel-timer-immediately', async (t) => {
    const { client } = t.context;
    const workflow = await client.start(workflows.cancelTimer, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    const res = await workflow.result();
    t.is(res, undefined);
    const execution = await client.workflowService.getWorkflowExecutionHistory({
      namespace,
      execution: { workflowId: workflow.workflowId, runId: workflow.firstExecutionRunId },
    });
    const timerEvents = execution.history!.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
    // Timer is cancelled before it is scheduled
    t.is(timerEvents.length, 0);
  });

  test('cancel-timer-with-delay', async (t) => {
    const { client } = t.context;
    const workflow = await client.start(workflows.cancelTimerWithDelay, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    const res = await workflow.result();
    t.is(res, undefined);
    const execution = await client.workflowService.getWorkflowExecutionHistory({
      namespace,
      execution: { workflowId: workflow.workflowId, runId: workflow.firstExecutionRunId },
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
    const workflow = await client.start(workflows.patchedWorkflow, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    const res = await workflow.result();
    t.is(res, undefined);
    const execution = await client.workflowService.getWorkflowExecutionHistory({
      namespace,
      execution: { workflowId: workflow.workflowId, runId: workflow.firstExecutionRunId },
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
    const workflow = await client.start(workflows.deprecatePatchWorkflow, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    const res = await workflow.result();
    t.is(res, undefined);
    const execution = await client.workflowService.getWorkflowExecutionHistory({
      namespace,
      execution: { workflowId: workflow.workflowId, runId: workflow.firstExecutionRunId },
    });
    const hasChangeEvents = execution.history!.events!.filter(
      ({ eventType }) => eventType === iface.temporal.api.enums.v1.EventType.EVENT_TYPE_MARKER_RECORDED
    );
    t.is(hasChangeEvents.length, 1);
    t.is(hasChangeEvents[0].markerRecordedEventAttributes!.markerName, CHANGE_MARKER_NAME);
  });

  test('Worker default ServerOptions are generated correctly', async (t) => {
    const { client } = t.context;
    const workflow = await client.start(workflows.argsAndReturn, {
      args: ['hey', undefined, Buffer.from('abc')],
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    await workflow.result();
    const execution = await client.workflowService.getWorkflowExecutionHistory({
      namespace,
      execution: { workflowId: workflow.workflowId, runId: workflow.firstExecutionRunId },
    });
    const events = execution.history!.events!.filter(
      ({ eventType }) => eventType === iface.temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_TASK_COMPLETED
    );
    t.is(events.length, 1);
    const [event] = events;
    t.regex(event.workflowTaskCompletedEventAttributes!.identity!, /\d+@.+/);
    t.regex(event.workflowTaskCompletedEventAttributes!.binaryChecksum!, /@temporalio\/worker@\d+\.\d+\.\d+/);
  });

  test('WorkflowHandle.describe result is wrapped', async (t) => {
    const date = new Date();
    const { client } = t.context;
    const workflow = await client.start(workflows.argsAndReturn, {
      args: ['hey', undefined, Buffer.from('def')],
      taskQueue: 'test',
      workflowId: uuid4(),
      searchAttributes: {
        CustomKeywordField: ['test-value'],
        CustomIntField: [1, 2],
        CustomDatetimeField: [date, date],
      },
      memo: {
        note: 'foo',
      },
    });
    await workflow.result();
    const execution = await workflow.describe();
    t.deepEqual(execution.type, 'argsAndReturn');
    t.deepEqual(execution.memo, { note: 'foo' });
    t.true(execution.startTime instanceof Date);
    t.deepEqual(execution.searchAttributes!.CustomKeywordField, ['test-value']);
    t.deepEqual(execution.searchAttributes!.CustomIntField, [1, 2]);
    t.deepEqual(execution.searchAttributes!.CustomDatetimeField, [date, date]);
    t.regex((execution.searchAttributes!.BinaryChecksums as string[])[0], /@temporalio\/worker@/);
  });

  test('Workflow can read Search Attributes set at start', async (t) => {
    const date = new Date();
    const { client } = t.context;
    const workflow = await client.start(workflows.returnSearchAttributes, {
      taskQueue: 'test',
      workflowId: uuid4(),
      searchAttributes: {
        CustomKeywordField: ['test-value'],
        CustomIntField: [1, 2],
        CustomDatetimeField: [date, date],
      },
    });
    const result = await workflow.result();
    t.deepEqual(result, {
      CustomKeywordField: ['test-value'],
      CustomIntField: [1, 2],
      CustomDatetimeField: [date.toISOString(), date.toISOString()],
      datetimeInstanceofWorks: [false],
      datetimeType: ['Date'],
    });
  });

  test('Workflow can upsert Search Attributes', async (t) => {
    const date = new Date();
    const { client } = t.context;
    const workflow = await client.start(workflows.upsertAndReadSearchAttributes, {
      taskQueue: 'test',
      workflowId: uuid4(),
      args: [date.getTime()],
    });
    const result = await workflow.result();
    t.deepEqual(result, {
      CustomBoolField: [true],
      CustomIntField: [], // clear
      CustomKeywordField: ['durable code'],
      CustomTextField: ['is useful'],
      CustomDatetimeField: [date.toISOString()],
      CustomDoubleField: [3.14],
    });
    const { searchAttributes } = await workflow.describe();
    t.deepEqual(searchAttributes, {
      BinaryChecksums: [`@temporalio/worker@${pkg.version}`],
      CustomBoolField: [true],
      CustomIntField: [], // clear
      CustomKeywordField: ['durable code'],
      CustomTextField: ['is useful'],
      CustomDatetimeField: [date],
      CustomDoubleField: [3.14],
    });
  });

  test('Workflow can read WorkflowInfo', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const workflow = await client.start(workflows.returnWorkflowInfo, {
      taskQueue: 'test',
      workflowId,
      memo: {
        nested: { object: true },
      },
    });
    const result = await workflow.result();
    t.deepEqual(result, {
      memo: {
        nested: { object: true },
      },
      attempt: 1,
      firstExecutionRunId: workflow.firstExecutionRunId,
      namespace: 'default',
      taskTimeoutMs: 10_000,
      runId: workflow.firstExecutionRunId,
      taskQueue: 'test',
      workflowType: 'returnWorkflowInfo',
      workflowId,
    });
  });

  test('WorkflowOptions are passed correctly with defaults', async (t) => {
    const { client } = t.context;
    const workflow = await client.start(workflows.argsAndReturn, {
      args: ['hey', undefined, Buffer.from('def')],
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    await workflow.result();
    const execution = await workflow.describe();
    t.deepEqual(execution.type, 'argsAndReturn');
    t.deepEqual(Object.keys(execution.raw.workflowExecutionInfo!.searchAttributes!.indexedFields!), [
      'BinaryChecksums',
    ]);

    const checksums = searchAttributePayloadConverter.fromPayload(
      execution.raw.workflowExecutionInfo!.searchAttributes!.indexedFields!.BinaryChecksums!
    );
    t.true(checksums instanceof Array && checksums.length === 1);
    t.regex((checksums as string[])[0], /@temporalio\/worker@\d+\.\d+\.\d+/);
    t.is(execution.raw.executionConfig?.taskQueue?.name, 'test');
    t.is(
      execution.raw.executionConfig?.taskQueue?.kind,
      iface.temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_NORMAL
    );
    t.is(execution.raw.executionConfig?.workflowRunTimeout, null);
    t.is(execution.raw.executionConfig?.workflowExecutionTimeout, null);
  });

  test('WorkflowOptions are passed correctly', async (t) => {
    const { client } = t.context;
    const options = {
      taskQueue: 'test2',
      memo: { a: 'b' },
      searchAttributes: { CustomIntField: [3] },
      workflowId: uuid4(),
      workflowRunTimeout: '2s',
      workflowExecutionTimeout: '3s',
      workflowTaskTimeout: '1s',
    };
    const workflow = await client.start(workflows.sleeper, options);
    // Throws because we use a different task queue
    await t.throwsAsync(() => workflow.result(), {
      instanceOf: WorkflowFailedError,
      message: 'Workflow execution timed out',
    });
    const execution = await workflow.describe();
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
    t.deepEqual(execution.searchAttributes!.CustomIntField, [3]);
    t.is(execution.raw.executionConfig?.taskQueue?.name, 'test2');
    t.is(
      execution.raw.executionConfig?.taskQueue?.kind,
      iface.temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_NORMAL
    );

    t.is(tsToMs(execution.raw.executionConfig!.workflowRunTimeout!), ms(options.workflowRunTimeout));
    t.is(tsToMs(execution.raw.executionConfig!.workflowExecutionTimeout!), ms(options.workflowExecutionTimeout));
    t.is(tsToMs(execution.raw.executionConfig!.defaultWorkflowTaskTimeout!), ms(options.workflowTaskTimeout));
  });

  test('WorkflowHandle.result() throws if terminated', async (t) => {
    const { client } = t.context;
    const workflow = await client.start(workflows.sleeper, {
      taskQueue: 'test',
      workflowId: uuid4(),
      args: [1000000],
    });
    await workflow.terminate('hasta la vista baby');
    await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowFailedError,
      message: 'hasta la vista baby',
    });
  });

  test('WorkflowHandle.result() throws if continued as new', async (t) => {
    const { client } = t.context;
    const ogWF = await client.start(workflows.continueAsNewSameWorkflow, {
      taskQueue: 'test',
      workflowId: uuid4(),
      followRuns: false,
    });
    let err = await t.throwsAsync(ogWF.result(), { instanceOf: WorkflowContinuedAsNewError });
    if (!(err instanceof WorkflowContinuedAsNewError)) return; // Type assertion
    let workflow = client.getHandle<typeof workflows.continueAsNewSameWorkflow>(
      ogWF.workflowId,
      err.newExecutionRunId,
      {
        followRuns: false,
      }
    );

    await workflow.signal(workflows.continueAsNewSignal);
    err = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowContinuedAsNewError,
    });
    if (!(err instanceof WorkflowContinuedAsNewError)) return; // Type assertion

    workflow = client.getHandle<typeof workflows.continueAsNewSameWorkflow>(workflow.workflowId, err.newExecutionRunId);
    await workflow.result();
  });

  test('WorkflowHandle.result() follows chain of execution', async (t) => {
    const { client } = t.context;
    await client.execute(workflows.continueAsNewSameWorkflow, {
      taskQueue: 'test',
      workflowId: uuid4(),
      args: ['execute', 'none'],
    });
    t.pass();
  });

  test('continue-as-new-to-different-workflow', async (t) => {
    const { client } = t.context;
    const ogWF = await client.start(workflows.continueAsNewToDifferentWorkflow, {
      taskQueue: 'test',
      workflowId: uuid4(),
      followRuns: false,
    });
    const err = await t.throwsAsync(ogWF.result(), { instanceOf: WorkflowContinuedAsNewError });
    if (!(err instanceof WorkflowContinuedAsNewError)) return; // Type assertion
    const workflow = client.getHandle<typeof workflows.sleeper>(ogWF.workflowId, err.newExecutionRunId, {
      followRuns: false,
    });
    await workflow.result();
    const info = await workflow.describe();
    t.is(info.raw.workflowExecutionInfo?.type?.name, 'sleeper');
    const { history } = await client.workflowService.getWorkflowExecutionHistory({
      namespace,
      execution: { workflowId: workflow.workflowId, runId: err.newExecutionRunId },
    });
    const timeSlept = await decodeFromPayloadsAtIndex(
      loadedDataConverter,
      0,
      history?.events?.[0].workflowExecutionStartedEventAttributes?.input?.payloads
    );
    t.is(timeSlept, 1);
  });

  test('signalWithStart works as intended and returns correct runId', async (t) => {
    const { client } = t.context;
    const ogWF = await client.signalWithStart(workflows.interruptableWorkflow, {
      taskQueue: 'test',
      workflowId: uuid4(),
      signal: workflows.interruptSignal,
      signalArgs: ['interrupted from signalWithStart'],
    });
    {
      const err: WorkflowFailedError = await t.throwsAsync(ogWF.result(), {
        instanceOf: WorkflowFailedError,
      });
      if (!(err.cause instanceof ApplicationFailure)) {
        return t.fail('Expected err.cause to be an instance of ApplicationFailure');
      }
      t.is(err.cause.message, 'interrupted from signalWithStart');
    }
    // Test returned runId
    const workflow = client.getHandle<typeof workflows.interruptableWorkflow>(ogWF.workflowId, ogWF.signaledRunId);
    {
      const err: WorkflowFailedError = await t.throwsAsync(workflow.result(), {
        instanceOf: WorkflowFailedError,
      });
      if (!(err.cause instanceof ApplicationFailure)) {
        return t.fail('Expected err.cause to be an instance of ApplicationFailure');
      }
      t.is(err.cause.message, 'interrupted from signalWithStart');
    }
  });

  test('activity-failures', async (t) => {
    const { client } = t.context;
    await client.execute(workflows.activityFailures, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    t.pass();
  });

  test('sleepInvalidDuration is caught in Workflow runtime', async (t) => {
    const { client } = t.context;
    await client.execute(workflows.sleepInvalidDuration, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    t.pass();
  });

  test('unhandledRejection causes WFT to fail', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handle = await client.start(workflows.throwUnhandledRejection, {
      taskQueue: 'test',
      workflowId,
      // throw an exception that our worker can associate with a running workflow
      args: [{ crashWorker: false }],
    });
    await asyncRetry(
      async () => {
        const history = await client.workflowService.getWorkflowExecutionHistory({
          namespace: 'default',
          execution: { workflowId },
        });
        const wftFailedEvent = history.history?.events?.find((ev) => ev.workflowTaskFailedEventAttributes);
        if (wftFailedEvent === undefined) {
          throw new Error('No WFT failed event');
        }
        const failure = wftFailedEvent.workflowTaskFailedEventAttributes?.failure;
        if (!failure) {
          t.fail();
          return;
        }
        t.is(failure.message, 'unhandled rejection');
        t.true(failure.stackTrace?.includes(`Error: unhandled rejection`));
        t.is(failure.cause?.message, 'root failure');
      },
      { minTimeout: 300, factor: 1, retries: 100 }
    );
    await handle.terminate();
  });

  test('throwObject includes message with our recommendation', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handle = await client.start(workflows.throwObject, {
      taskQueue: 'test',
      workflowId,
    });
    await asyncRetry(
      async () => {
        const history = await client.workflowService.getWorkflowExecutionHistory({
          namespace: 'default',
          execution: { workflowId },
        });
        const wftFailedEvent = history.history?.events?.find((ev) => ev.workflowTaskFailedEventAttributes);
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
    );
    await handle.terminate();
  });

  test('throwBigInt includes message with our recommendation', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handle = await client.start(workflows.throwBigInt, {
      taskQueue: 'test',
      workflowId,
    });
    await asyncRetry(
      async () => {
        const history = await client.workflowService.getWorkflowExecutionHistory({
          namespace: 'default',
          execution: { workflowId },
        });
        const wftFailedEvent = history.history?.events?.find((ev) => ev.workflowTaskFailedEventAttributes);
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
    );
    await handle.terminate();
  });

  test('Workflow RetryPolicy kicks in with retryable failure', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handle = await client.start(workflows.throwAsync, {
      taskQueue: 'test',
      workflowId,
      args: ['retryable'],
      retry: {
        initialInterval: 1,
        maximumInterval: 1,
        maximumAttempts: 2,
      },
    });
    await t.throwsAsync(handle.result());
    // Verify retry happened
    const { runId } = await handle.describe();
    t.not(runId, handle.firstExecutionRunId);
  });

  test('Workflow RetryPolicy ignored with nonRetryable failure', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handle = await client.start(workflows.throwAsync, {
      taskQueue: 'test',
      workflowId,
      args: ['nonRetryable'],
      retry: {
        initialInterval: 1,
        maximumInterval: 1,
        maximumAttempts: 2,
      },
    });
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

  test('WorkflowClient.start fails with WorkflowExecutionAlreadyStartedError', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handle = await client.start(workflows.sleeper, { taskQueue: 'test', workflowId, args: [10000000] });
    try {
      await t.throwsAsync(
        client.start(workflows.sleeper, {
          taskQueue: 'test',
          workflowId,
        }),
        { instanceOf: WorkflowExecutionAlreadyStartedError, message: 'Workflow execution already started' }
      );
    } finally {
      await handle.terminate();
    }
  });

  test('Handle from WorkflowClient.start follows only own execution chain', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handleFromThrowerStart = await client.start(workflows.throwAsync, { taskQueue: 'test', workflowId });
    const handleFromGet = client.getHandle(workflowId);
    await t.throwsAsync(handleFromGet.result(), { message: /.*/ });
    const handleFromSleeperStart = await client.start(workflows.sleeper, {
      taskQueue: 'test',
      workflowId,
      args: [1_000_000],
    });
    try {
      await t.throwsAsync(handleFromThrowerStart.result(), { message: 'Workflow execution failed' });
    } finally {
      await handleFromSleeperStart.terminate();
    }
  });

  test('Handle from WorkflowClient.signalWithStart follows only own execution chain', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handleFromThrowerStart = await client.signalWithStart(workflows.throwAsync, {
      taskQueue: 'test',
      workflowId,
      signal: 'unblock',
      signalArgs: [],
    });
    const handleFromGet = client.getHandle(workflowId);
    await t.throwsAsync(handleFromGet.result(), { message: /.*/ });
    const handleFromSleeperStart = await client.start(workflows.sleeper, {
      taskQueue: 'test',
      workflowId,
      args: [1_000_000],
    });
    try {
      await t.throwsAsync(handleFromThrowerStart.result(), { message: 'Workflow execution failed' });
    } finally {
      await handleFromSleeperStart.terminate();
    }
  });

  test('Handle from WorkflowClient.getHandle follows only own execution chain', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handleFromThrowerStart = await client.start(workflows.throwAsync, {
      taskQueue: 'test',
      workflowId,
    });
    const handleFromGet = client.getHandle(workflowId, undefined, {
      firstExecutionRunId: handleFromThrowerStart.firstExecutionRunId,
    });
    await t.throwsAsync(handleFromThrowerStart.result(), { message: /.*/ });
    const handleFromSleeperStart = await client.start(workflows.sleeper, {
      taskQueue: 'test',
      workflowId,
      args: [1_000_000],
    });
    try {
      await t.throwsAsync(handleFromGet.result(), { message: 'Workflow execution failed' });
    } finally {
      await handleFromSleeperStart.terminate();
    }
  });

  test('Handle from WorkflowClient.start terminates run after continue as new', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handleFromStart = await client.start(workflows.continueAsNewToDifferentWorkflow, {
      taskQueue: 'test',
      workflowId,
      args: [1_000_000],
    });
    const handleFromGet = client.getHandle(workflowId, handleFromStart.firstExecutionRunId, { followRuns: false });
    await t.throwsAsync(handleFromGet.result(), { instanceOf: WorkflowContinuedAsNewError });
    await handleFromStart.terminate();
    await t.throwsAsync(handleFromStart.result(), { message: 'Workflow execution terminated' });
  });

  test('Handle from WorkflowClient.getHandle does not terminate run after continue as new if given runId', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handleFromStart = await client.start(workflows.continueAsNewToDifferentWorkflow, {
      taskQueue: 'test',
      workflowId,
      args: [1_000_000],
      followRuns: false,
    });
    const handleFromGet = client.getHandle(workflowId, handleFromStart.firstExecutionRunId);
    await t.throwsAsync(handleFromStart.result(), { instanceOf: WorkflowContinuedAsNewError });
    try {
      await t.throwsAsync(handleFromGet.terminate(), {
        instanceOf: WorkflowNotFoundError,
        message: 'workflow execution already completed',
      });
    } finally {
      await client.getHandle(workflowId).terminate();
    }
  });

  test('Runtime does not issue cancellations for activities and timers that throw during validation', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    await client.execute(workflows.cancelScopeOnFailedValidation, {
      taskQueue: 'test',
      workflowId,
    });
    t.pass();
  });

  if ('promiseHooks' in v8) {
    // Skip in old node versions
    test('Stack trace query returns stack that makes sense', async (t) => {
      const { client } = t.context;
      const workflowId = uuid4();
      const rawStacks = await client.execute(workflows.stackTracer, {
        taskQueue: 'test',
        workflowId,
      });

      const [stack1, stack2] = rawStacks.map((r) =>
        r
          .split('\n\n')
          .map((s) => cleanOptionalStackTrace(`\n${s}`))
          .join('\n')
      );
      // Can't get the Trigger stack cleaned, this is okay for now
      // NOTE: we check endsWith because under certain conditions we might see Promise.race in the trace
      t.true(
        stack1.endsWith(
          `
    at Function.all (<anonymous>)
    at stackTracer (test/src/workflows/stack-tracer.ts)

    at stackTracer (test/src/workflows/stack-tracer.ts)

    at Promise.then (<anonymous>)
    at Trigger.then (workflow/src/trigger.ts)`
        ),
        `Got invalid stack:\n--- clean ---\n${stack1}\n--- raw ---\n${rawStacks[0]}`
      );
      t.is(
        stack2,
        `
    at executeChild (workflow/src/workflow.ts)
    at stackTracer (test/src/workflows/stack-tracer.ts)

    at new Promise (<anonymous>)
    at timerNextHandler (workflow/src/workflow.ts)
    at sleep (workflow/src/workflow.ts)
    at stackTracer (test/src/workflows/stack-tracer.ts)

    at stackTracer (test/src/workflows/stack-tracer.ts)`
      );
    });
  }
}
