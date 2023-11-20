/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import path from 'node:path';
import v8 from 'node:v8';
import { readFileSync } from 'node:fs';
import asyncRetry from 'async-retry';
import anyTest, { Implementation, TestFn } from 'ava';
import dedent from 'dedent';
import { v4 as uuid4 } from 'uuid';
import {
  ActivityFailure,
  ApplicationFailure,
  Client,
  Connection,
  QueryNotRegisteredError,
  WorkflowClient,
  WorkflowContinuedAsNewError,
  WorkflowFailedError,
} from '@temporalio/client';
import {
  ChildWorkflowFailure,
  DataConverter,
  defaultFailureConverter,
  defaultPayloadConverter,
  Payload,
  PayloadCodec,
  RetryState,
  searchAttributePayloadConverter,
  TerminatedFailure,
  TimeoutFailure,
  TimeoutType,
  WorkflowExecution,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
  WorkflowNotFoundError,
} from '@temporalio/common';
import { msToNumber, tsToMs } from '@temporalio/common/lib/time';
import { decode, decodeFromPayloadsAtIndex } from '@temporalio/common/lib/internal-non-workflow';
import * as iface from '@temporalio/proto';
import { DefaultLogger, makeTelemetryFilterString, Runtime } from '@temporalio/worker';
import pkg from '@temporalio/worker/lib/pkg';
import { UnsafeWorkflowInfo } from '@temporalio/workflow/src/interfaces';
import * as activities from './activities';
import { ConnectionInjectorInterceptor } from './activities/interceptors';
import { cleanOptionalStackTrace, registerDefaultCustomSearchAttributes, u8, Worker } from './helpers';
import * as workflows from './workflows';
import { withZeroesHTTPServer } from './zeroes-http-server';

const { EVENT_TYPE_TIMER_STARTED, EVENT_TYPE_TIMER_FIRED, EVENT_TYPE_TIMER_CANCELED } =
  iface.temporal.api.enums.v1.EventType;

const timerEventTypes = new Set([EVENT_TYPE_TIMER_STARTED, EVENT_TYPE_TIMER_FIRED, EVENT_TYPE_TIMER_CANCELED]);
const CHANGE_MARKER_NAME = 'core_patch';

export interface Context {
  worker: Worker;
  client: WorkflowClient;
  metaClient: Client;
  dataConverter: DataConverter;
  runPromise: Promise<void>;
}

const _test = anyTest as TestFn<Context>;

export function runIntegrationTests(codec?: PayloadCodec): void {
  const test = (name: string, fn: Implementation<[], Context>) => _test(codec ? 'With codec—' + name : name, fn);
  const dataConverter = { payloadCodecs: codec ? [codec] : [] };
  const loadedDataConverter = {
    payloadConverter: defaultPayloadConverter,
    payloadCodecs: codec ? [codec] : [],
    failureConverter: defaultFailureConverter,
  };

  async function fromPayload(payload: Payload) {
    const [decodedPayload] = await decode(dataConverter.payloadCodecs, [payload]);
    return defaultPayloadConverter.fromPayload(decodedPayload);
  }

  _test.before(async (t) => {
    const logger = new DefaultLogger('DEBUG');
    // Use forwarded logging from core
    Runtime.install({
      logger,
      telemetryOptions: {
        logging: {
          filter: makeTelemetryFilterString({ core: 'INFO', other: 'INFO' }),
          forward: {},
        },
      },
    });
    const connection = await Connection.connect();
    await registerDefaultCustomSearchAttributes(connection);

    const worker = await Worker.create({
      workflowsPath: require.resolve('./workflows'),
      activities,
      taskQueue: 'test',
      dataConverter,
      interceptors: {
        activity: [() => ({ inbound: new ConnectionInjectorInterceptor(connection, loadedDataConverter) })],
      },
      showStackTraceSources: true,
    });

    const runPromise = worker.run();
    // Catch the error here to avoid unhandled rejection
    runPromise.catch((err) => {
      console.error('Caught error while worker was running', err);
    });

    const metaClient = new Client({ connection, dataConverter });
    t.context = {
      worker,
      runPromise,
      dataConverter,
      client: metaClient.workflow,
      metaClient,
    };
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
          const history = await handle.fetchHistory();
          if (
            !history?.events?.some(
              ({ workflowTaskFailedEventAttributes }) =>
                workflowTaskFailedEventAttributes?.failure?.message ===
                "Failed to initialize workflow of type 'not-found': no such function is exported by the workflow bundle"
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

  test('url-whatwg', async (t) => {
    const { client } = t.context;
    const res = await client.execute(workflows.urlEcho, {
      taskQueue: 'test',
      workflowId: uuid4(),
      args: ['http://foo.com'],
    });
    t.is(res, 'http://foo.com/?counter=1');
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
    const err: WorkflowFailedError | undefined = await t.throwsAsync(
      client.execute(workflows.activityFailure, {
        taskQueue: 'test',
        workflowId: uuid4(),
        args: [{ useApplicationFailure: false }],
      }),
      {
        instanceOf: WorkflowFailedError,
      }
    );
    t.is(err?.message, 'Workflow execution failed');
    if (!(err?.cause instanceof ActivityFailure)) {
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
        at throwAnError (test/src/activities/index.ts)
        at ConnectionInjectorInterceptor.execute (test/src/activities/interceptors.ts)
    `
    );
  });

  test('activity-failure with ApplicationFailure', async (t) => {
    const { client } = t.context;
    const err: WorkflowFailedError | undefined = await t.throwsAsync(
      client.execute(workflows.activityFailure, {
        taskQueue: 'test',
        workflowId: uuid4(),
        args: [{ useApplicationFailure: true }],
      }),
      {
        instanceOf: WorkflowFailedError,
      }
    );
    t.is(err?.message, 'Workflow execution failed');
    if (!(err?.cause instanceof ActivityFailure)) {
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
        at throwAnError (test/src/activities/index.ts)
        at ConnectionInjectorInterceptor.execute (test/src/activities/interceptors.ts)
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
    const err: WorkflowFailedError | undefined = await t.throwsAsync(
      client.execute(workflows.childWorkflowFailure, {
        taskQueue: 'test',
        workflowId: uuid4(),
      }),
      {
        instanceOf: WorkflowFailedError,
      }
    );
    if (!(err?.cause instanceof ChildWorkflowFailure)) {
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
    const err: WorkflowFailedError | undefined = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowFailedError,
    });
    if (!(err?.cause instanceof ChildWorkflowFailure)) {
      return t.fail('Expected err.cause to be an instance of ChildWorkflowFailure');
    }
    t.is(err.cause.retryState, RetryState.RETRY_STATE_NON_RETRYABLE_FAILURE);
    if (!(err.cause.cause instanceof TerminatedFailure)) {
      return t.fail('Expected err.cause.cause to be an instance of TerminatedFailure');
    }
  });

  test('child-workflow-timeout', async (t) => {
    const { client } = t.context;
    const err: WorkflowFailedError | undefined = await t.throwsAsync(
      client.execute(workflows.childWorkflowTimeout, {
        taskQueue: 'test',
        workflowId: uuid4(),
      }),
      {
        instanceOf: WorkflowFailedError,
      }
    );
    if (!(err?.cause instanceof ChildWorkflowFailure)) {
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

  test('query not found', async (t) => {
    const { client } = t.context;
    const workflow = await client.start(workflows.unblockOrCancel, {
      taskQueue: 'test',
      workflowId: uuid4(),
    });
    await workflow.signal(workflows.unblockSignal);
    await workflow.result();
    await t.throwsAsync(workflow.query('not found'), {
      instanceOf: QueryNotRegisteredError,
      message:
        'Workflow did not register a handler for not found. Registered queries: [__stack_trace __enhanced_stack_trace isBlocked]',
    });
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
    const err: WorkflowFailedError | undefined = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowFailedError,
    });
    if (!(err?.cause instanceof ApplicationFailure)) {
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
    const err: WorkflowFailedError | undefined = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowFailedError,
    });
    if (!(err?.cause instanceof ApplicationFailure)) {
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
    const err: WorkflowFailedError | undefined = await t.throwsAsync(workflow.result(), {
      instanceOf: WorkflowFailedError,
    });
    if (!(err?.cause instanceof ApplicationFailure)) {
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
    const history = await workflow.fetchHistory();
    const timerEvents = history.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
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
    const history = await workflow.fetchHistory();
    const timerEvents = history.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
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
    const history = await workflow.fetchHistory();
    const timerEvents = history.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
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
    const history = await workflow.fetchHistory();
    const hasChangeEvents = history.events!.filter(
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
    const history = await workflow.fetchHistory();
    const hasChangeEvents = history.events!.filter(
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
    const history = await workflow.fetchHistory();
    const events = history.events!.filter(
      ({ eventType }) => eventType === iface.temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_TASK_COMPLETED
    );
    t.is(events.length, 1);
    const [event] = events;
    t.regex(event.workflowTaskCompletedEventAttributes!.identity!, /\d+@.+/);
    let binid = event.workflowTaskCompletedEventAttributes!.binaryChecksum!;
    if (binid === '') {
      binid = event.workflowTaskCompletedEventAttributes!.workerVersion!.buildId!;
    }
    t.regex(binid, /@temporalio\/worker@\d+\.\d+\.\d+/);
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
        CustomIntField: [1],
        CustomDatetimeField: [date],
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
    t.deepEqual(execution.searchAttributes!.CustomIntField, [1]);
    t.deepEqual(execution.searchAttributes!.CustomDatetimeField, [date]);
    const binSum = execution.searchAttributes!.BinaryChecksums as string[];
    if (binSum != null) {
      t.regex(binSum[0], /@temporalio\/worker@/);
    } else {
      t.deepEqual(execution.searchAttributes!.BuildIds, [
        'unversioned',
        `unversioned:${t.context.worker.options.buildId}`,
      ]);
    }
  });

  test('Workflow can read Search Attributes set at start', async (t) => {
    const date = new Date();
    const { client } = t.context;
    const workflow = await client.start(workflows.returnSearchAttributes, {
      taskQueue: 'test',
      workflowId: uuid4(),
      searchAttributes: {
        CustomKeywordField: ['test-value'],
        CustomIntField: [1],
        CustomDatetimeField: [date],
      },
    });
    const result = await workflow.result();
    t.deepEqual(result, {
      CustomKeywordField: ['test-value'],
      CustomIntField: [1],
      CustomDatetimeField: [date.toISOString()],
      datetimeInstanceofWorks: [true],
      arrayInstanceofWorks: [true],
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
    const { BinaryChecksums, BuildIds, ...rest } = searchAttributes;
    t.deepEqual(rest, {
      CustomBoolField: [true],
      CustomKeywordField: ['durable code'],
      CustomTextField: ['is useful'],
      CustomDatetimeField: [date],
      CustomDoubleField: [3.14],
    });
    let checksum: any;
    if (BinaryChecksums != null) {
      t.true(BinaryChecksums.length === 1);
      checksum = BinaryChecksums[0];
    } else {
      t.true(BuildIds!.length === 2);
      t.deepEqual(BuildIds![0], 'unversioned');
      checksum = BuildIds![1];
    }
    t.true(
      typeof checksum === 'string' &&
        checksum.includes(`@temporalio/worker@${pkg.version}+`) &&
        /\+[a-f0-9]{64}$/.test(checksum) // bundle checksum
    );
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
    t.assert(result.historySize > 300);
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
      searchAttributes: {},
      workflowType: 'returnWorkflowInfo',
      workflowId,
      historyLength: 3,
      continueAsNewSuggested: false,
      // values ignored for the purpose of comparison
      historySize: result.historySize,
      startTime: result.startTime,
      runStartTime: result.runStartTime,
      // unsafe.now is a function, so doesn't make it through serialization, but .now is required, so we need to cast
      unsafe: { isReplaying: false } as UnsafeWorkflowInfo,
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
    } as const;
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

    t.is(tsToMs(execution.raw.executionConfig!.workflowRunTimeout!), msToNumber(options.workflowRunTimeout));
    t.is(
      tsToMs(execution.raw.executionConfig!.workflowExecutionTimeout!),
      msToNumber(options.workflowExecutionTimeout)
    );
    t.is(tsToMs(execution.raw.executionConfig!.defaultWorkflowTaskTimeout!), msToNumber(options.workflowTaskTimeout));
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
    const history = await workflow.fetchHistory();
    const timeSlept = await decodeFromPayloadsAtIndex(
      loadedDataConverter,
      0,
      history?.events?.[0].workflowExecutionStartedEventAttributes?.input?.payloads
    );
    t.is(timeSlept, 1);
  });

  test('continue-as-new-to-same-workflow keeps memo and search attributes', async (t) => {
    const { client } = t.context;
    const workflow = await client.start(workflows.continueAsNewSameWorkflow, {
      taskQueue: 'test',
      workflowId: uuid4(),
      memo: {
        note: 'foo',
      },
      searchAttributes: {
        CustomKeywordField: ['test-value'],
        CustomIntField: [1],
      },
      followRuns: true,
    });
    await workflow.signal(workflows.continueAsNewSignal);
    await workflow.result();

    const execution = await workflow.describe();
    t.not(execution.runId, workflow.firstExecutionRunId);
    t.deepEqual(execution.memo, { note: 'foo' });
    t.deepEqual(execution.searchAttributes!.CustomKeywordField, ['test-value']);
    t.deepEqual(execution.searchAttributes!.CustomIntField, [1]);
  });

  test('continue-as-new-to-different-workflow keeps memo and search attributes by default', async (t) => {
    const { client } = t.context;
    const workflow = await client.start(workflows.continueAsNewToDifferentWorkflow, {
      taskQueue: 'test',
      workflowId: uuid4(),
      followRuns: true,
      memo: {
        note: 'foo',
      },
      searchAttributes: {
        CustomKeywordField: ['test-value'],
        CustomIntField: [1],
      },
    });
    await workflow.result();
    const info = await workflow.describe();
    t.is(info.type, 'sleeper');
    t.not(info.runId, workflow.firstExecutionRunId);
    t.deepEqual(info.memo, { note: 'foo' });
    t.deepEqual(info.searchAttributes!.CustomKeywordField, ['test-value']);
    t.deepEqual(info.searchAttributes!.CustomIntField, [1]);
  });

  test('continue-as-new-to-different-workflow can set memo and search attributes', async (t) => {
    const { client } = t.context;
    const workflow = await client.start(workflows.continueAsNewToDifferentWorkflow, {
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
      taskQueue: 'test',
      workflowId: uuid4(),
      followRuns: true,
      memo: {
        note: 'foo',
      },
      searchAttributes: {
        CustomKeywordField: ['test-value'],
        CustomIntField: [1],
      },
    });
    await workflow.result();
    const info = await workflow.describe();
    t.is(info.type, 'sleeper');
    t.not(info.runId, workflow.firstExecutionRunId);
    t.deepEqual(info.memo, { note: 'bar' });
    t.deepEqual(info.searchAttributes!.CustomKeywordField, ['test-value-2']);
    t.deepEqual(info.searchAttributes!.CustomIntField, [3]);
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
      const err: WorkflowFailedError | undefined = await t.throwsAsync(ogWF.result(), {
        instanceOf: WorkflowFailedError,
      });
      if (!(err?.cause instanceof ApplicationFailure)) {
        return t.fail('Expected err.cause to be an instance of ApplicationFailure');
      }
      t.is(err.cause.message, 'interrupted from signalWithStart');
    }
    // Test returned runId
    const workflow = client.getHandle<typeof workflows.interruptableWorkflow>(ogWF.workflowId, ogWF.signaledRunId);
    {
      const err: WorkflowFailedError | undefined = await t.throwsAsync(workflow.result(), {
        instanceOf: WorkflowFailedError,
      });
      if (!(err?.cause instanceof ApplicationFailure)) {
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
    const handle = await client.start(workflows.sleeper, {
      taskQueue: 'test',
      workflowId,
      args: [10000000],
    });
    try {
      await t.throwsAsync(
        client.start(workflows.sleeper, {
          taskQueue: 'test',
          workflowId,
        }),
        {
          instanceOf: WorkflowExecutionAlreadyStartedError,
          message: 'Workflow execution already started',
        }
      );
    } finally {
      await handle.terminate();
    }
  });

  test('WorkflowClient.signalWithStart fails with WorkflowExecutionAlreadyStartedError', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    await client.execute(workflows.sleeper, {
      taskQueue: 'test',
      workflowId,
    });
    await t.throwsAsync(
      client.signalWithStart(workflows.sleeper, {
        taskQueue: 'test',
        workflowId,
        signal: workflows.interruptSignal,
        signalArgs: ['interrupted from signalWithStart'],
        workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
      }),
      {
        instanceOf: WorkflowExecutionAlreadyStartedError,
        message: 'Workflow execution already started',
      }
    );
  });

  test('Handle from WorkflowClient.start follows only own execution chain', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handleFromThrowerStart = await client.start(workflows.throwAsync, {
      taskQueue: 'test',
      workflowId,
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

  test('Handle from WorkflowClient.signalWithStart follows only own execution chain', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handleFromThrowerStart = await client.signalWithStart(workflows.throwAsync, {
      taskQueue: 'test',
      workflowId,
      signal: 'unblock',
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

    test('Enhanced stack trace returns trace that makes sense', async (t) => {
      const { client } = t.context;
      const workflowId = uuid4();

      const enhancedStack = await client.execute(workflows.enhancedStackTracer, {
        taskQueue: 'test',
        workflowId,
      });

      const stacks = enhancedStack.stacks.map((s) => ({
        locations: s.locations.map((l) => ({
          ...l,
          ...(l.filePath
            ? { filePath: l.filePath.replace(path.resolve(__dirname, '../../../'), '').replace(/\\/g, '/') }
            : undefined),
        })),
      }));
      t.is(enhancedStack.sdk.name, 'typescript');
      t.is(enhancedStack.sdk.version, pkg.version); // Expect workflow and worker versions to match
      t.deepEqual(stacks, [
        {
          locations: [
            {
              functionName: 'Function.all',
            },
            {
              filePath: '/packages/test/src/workflows/stack-tracer.ts',
              functionName: 'enhancedStackTracer',
              line: 32,
              column: 35,
            },
          ],
        },
        {
          locations: [
            {
              filePath: '/packages/test/src/workflows/stack-tracer.ts',
              functionName: 'enhancedStackTracer',
              line: 32,
              column: 35,
            },
          ],
        },
        {
          locations: [
            {
              functionName: 'Promise.then',
            },
            {
              filePath: '/packages/workflow/src/trigger.ts',
              functionName: 'Trigger.then',
              line: 47,
              column: 24,
            },
          ],
        },
      ]);
      const expectedSources = ['../src/workflows/stack-tracer.ts', '../../workflow/src/trigger.ts'].map((p) => [
        path.resolve(__dirname, p),
        [{ content: readFileSync(path.resolve(__dirname, p), 'utf8'), lineOffset: 0 }],
      ]);
      t.deepEqual(Object.entries(enhancedStack.sources), expectedSources);
    });
  }

  test('Query does not cause condition to be triggered', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handle = await client.start(workflows.queryAndCondition, {
      taskQueue: 'test',
      workflowId,
    });
    await handle.query(workflows.mutateWorkflowStateQuery);
    await handle.terminate();
    // Worker did not crash
    t.pass();
  });

  /**
   * NOTE: this test uses the `IN` operator API which requires advanced visibility as of server 1.18.
   * It will silently succeed on servers that only support standard visibility (can't dynamically skip a test).
   */
  test('Download and replay multiple executions with client list method', async (t) => {
    try {
      const { metaClient: client } = t.context;
      const taskQueue = 'test';
      const fns = [
        workflows.http,
        workflows.cancelFakeProgress,
        workflows.childWorkflowInvoke,
        workflows.activityFailures,
      ];
      const handles = await Promise.all(
        fns.map((fn) =>
          client.workflow.start(fn, {
            taskQueue,
            workflowId: uuid4(),
          })
        )
      );
      // Wait for the workflows to complete first
      await Promise.all(handles.map((h) => h.result()));
      // Test the list API too while we're at it
      const workflowIds = handles.map(({ workflowId }) => `'${workflowId}'`);
      const histories = client.workflow.list({ query: `WorkflowId IN (${workflowIds.join(', ')})` }).intoHistories();
      const results = await Worker.runReplayHistories(
        {
          workflowsPath: require.resolve('./workflows'),
          dataConverter: t.context.dataConverter,
        },
        histories
      );

      for await (const result of results) {
        t.is(result.error, undefined);
      }
    } catch (e) {
      // Don't report a test failure if the server does not support extended query
      if (!(e as Error).message?.includes(`operator 'in' not allowed`)) throw e;
    }
    t.pass();
  });
}
