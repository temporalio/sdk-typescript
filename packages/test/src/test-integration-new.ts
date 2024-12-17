/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import asyncRetry from 'async-retry';
import { v4 as uuid4 } from 'uuid';
import dedent from 'dedent';
import { ExecutionContext } from 'ava';
import * as iface from '@temporalio/proto';
import {
  ActivityFailure,
  ChildWorkflowFailure,
  QueryNotRegisteredError,
  WorkflowContinuedAsNewError,
  WorkflowFailedError,
} from '@temporalio/client';
import {
  ActivityCancellationType,
  ApplicationFailure,
  CancelledFailure,
  defaultFailureConverter,
  defaultPayloadConverter,
  LoadedDataConverter,
  Payload,
  RetryState,
  searchAttributePayloadConverter,
  SearchAttributes,
  TerminatedFailure,
  TimeoutFailure,
  TimeoutType,
  WorkflowExecution,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from '@temporalio/common';
import { msToNumber, tsToMs } from '@temporalio/common/lib/time';
import pkg from '@temporalio/worker/lib/pkg';
import { UnsafeWorkflowInfo, WorkflowInfo } from '@temporalio/workflow/lib/interfaces';
import { decode as payloadDecode, decodeFromPayloadsAtIndex } from '@temporalio/common/lib/internal-non-workflow';
import { WorkerOptions, WorkflowBundle } from '@temporalio/worker';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  CancellationScope,
  condition,
  defineQuery,
  executeChild,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';
import { ConnectionInjectorInterceptor } from './activities/interceptors';
import {
  configurableHelpers,
  createLocalTestEnvironment,
  createTestWorkflowBundle,
  makeConfigurableEnvironmentTestFn,
} from './helpers-integration';
import * as activities from './activities';
import {
  ByteSkewerPayloadCodec,
  cleanOptionalStackTrace,
  registerDefaultCustomSearchAttributes,
  u8,
  Worker,
} from './helpers';
import * as workflows from './workflows';

// Note: re-export shared workflows (or long workflows)
//  - review the files where these workflows are shared
export * from './workflows';

const { EVENT_TYPE_TIMER_STARTED, EVENT_TYPE_TIMER_FIRED, EVENT_TYPE_TIMER_CANCELED } =
  iface.temporal.api.enums.v1.EventType;

const timerEventTypes = new Set([EVENT_TYPE_TIMER_STARTED, EVENT_TYPE_TIMER_FIRED, EVENT_TYPE_TIMER_CANCELED]);
const CHANGE_MARKER_NAME = 'core_patch';

interface TestConfig {
  loadedDataConverter: LoadedDataConverter;
  env: TestWorkflowEnvironment;
  createWorkerWithDefaults: (t: ExecutionContext<TestContext>, opts?: Partial<WorkerOptions>) => Promise<Worker>;
}
interface TestContext {
  workflowBundle: WorkflowBundle;
  configs: TestConfig[];
}

const codecs = [undefined, new ByteSkewerPayloadCodec()];


const test = makeConfigurableEnvironmentTestFn<TestContext>({
  createTestContext: async (_t: ExecutionContext) => {
    const workflowBundle = await createTestWorkflowBundle(__filename);
    const configs: TestConfig[] = [];
    await Promise.all(
      codecs.map(async (codec) => {
        const dataConverter = { payloadCodecs: codec ? [codec] : [] };
        const loadedDataConverter = {
          payloadConverter: defaultPayloadConverter,
          payloadCodecs: codec ? [codec] : [],
          failureConverter: defaultFailureConverter,
        };

        const env = await createLocalTestEnvironment({
          client: { dataConverter },
        });
        await registerDefaultCustomSearchAttributes(env.connection);

        configs.push({
          loadedDataConverter,
          env,
          createWorkerWithDefaults(t: ExecutionContext<TestContext>, opts?: Partial<WorkerOptions>): Promise<Worker> {
            return configurableHelpers(t, t.context.workflowBundle, env).createWorker({
              dataConverter,
              interceptors: {
                activity: [() => ({ inbound: new ConnectionInjectorInterceptor(env.connection, loadedDataConverter) })],
              },
              ...opts,
            });
          },
        });
      })
    );
    return {
      workflowBundle,
      configs,
    };
  },
  teardown: async (testContext: TestContext) => {
    for (const config of testContext.configs) {
      await config.env.teardown();
    }
  },
});

const configMacro = test.macro(
  async (
    t: ExecutionContext<TestContext>,
    testFn: (t: ExecutionContext<TestContext>, config: TestConfig) => Promise<unknown> | unknown
  ) => {
    const testPromises = t.context.configs.map(async (config) => {
      // TODO(thomas): ideally, we'd like to add an annotation to the test name to indicate what codec it used
      await testFn(t, config);
    });
    await Promise.all(testPromises);
  }
);

test('Workflow not found results in task retry', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { taskQueue } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const client = env.client;
  const handle = await client.workflow.start('not-found', {
    taskQueue,
    workflowId: uuid4(),
  });

  await worker.runUntil(async () => {
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
  });

  t.pass();
});

test('args-and-return', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const res = await worker.runUntil(
    executeWorkflow(workflows.argsAndReturn, {
      args: ['Hello', undefined, u8('world!')],
    })
  );
  t.is(res, 'Hello, world!');
});

export async function urlEcho(url: string): Promise<string> {
  const parsedURL = new URL(url);
  const searchParams = new URLSearchParams({ counter: '1' });
  parsedURL.search = searchParams.toString();
  return parsedURL.toString();
}

test('url-whatwg', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const res = await worker.runUntil(
    executeWorkflow(urlEcho, {
      args: ['http://foo.com'],
    })
  );
  t.is(res, 'http://foo.com/?counter=1');
});

test('cancel-fake-progress', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);

  const worker = await createWorkerWithDefaults(t, {
    activities,
  });
  await worker.runUntil(executeWorkflow(workflows.cancelFakeProgress));
  t.pass();
});

export async function cancellableHTTPRequest(url: string): Promise<void> {
  const { cancellableFetch } = proxyActivities<typeof activities>({
    startToCloseTimeout: '20s',
    heartbeatTimeout: '3s',
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  });
  let activityStarted = false;
  setHandler(workflows.activityStartedSignal, () => void (activityStarted = true));
  try {
    await CancellationScope.cancellable(async () => {
      const promise = cancellableFetch(url, true);
      await condition(() => activityStarted);
      CancellationScope.current().cancel();
      await promise;
    });
  } catch (err) {
    if (!isCancellation(err)) {
      throw err;
    }
  }
}

// TODO(thomas): fix, withZeroesHTTPServer uses node:http
/*
test('cancel-http-request', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t, { activities });
  await withZeroesHTTPServer(async (port) => {
    const url = `http://127.0.0.1:${port}`;
    await worker.runUntil(executeWorkflow(cancellableHTTPRequest, {
        args: [url],
    }));
  });
  t.pass();
});
*/

export async function activityFailure(useApplicationFailure: boolean): Promise<void> {
  const { throwAnError } = proxyActivities({
    startToCloseTimeout: '5s',
    retry: { initialInterval: '1s', maximumAttempts: 1 },
  });
  if (useApplicationFailure) {
    await throwAnError(true, 'Fail me');
  } else {
    await throwAnError(false, 'Fail me');
  }
}

test('activity-failure with Error', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t, { activities });
  const err: WorkflowFailedError | undefined = await t.throwsAsync(
    worker.runUntil(
      executeWorkflow(activityFailure, {
        args: [false],
      })
    ),
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

test('activity-failure with ApplicationFailure', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t, { activities });
  const err: WorkflowFailedError | undefined = await t.throwsAsync(
    worker.runUntil(
      executeWorkflow(activityFailure, {
        args: [true],
      })
    ),
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

export async function childWorkflowInvoke(): Promise<{
  workflowId: string;
  runId: string;
  execResult: string;
  result: string;
}> {
  const child = await startChild(workflows.successString, {});
  const execResult = await executeChild(workflows.successString, {});
  return { workflowId: child.workflowId, runId: child.firstExecutionRunId, result: await child.result(), execResult };
}

test('child-workflow-invoke', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(childWorkflowInvoke);
  const { workflowId, runId, execResult, result } = await worker.runUntil(handle.result());
  t.is(execResult, 'success');
  t.is(result, 'success');
  const client = env.client;
  const child = client.workflow.getHandle(workflowId, runId);
  t.is(await child.result(), 'success');
});

export async function childWorkflowFailure(): Promise<void> {
  await executeChild(workflows.throwAsync);
}

test('child-workflow-failure', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  await worker.runUntil(async () => {
    const err: WorkflowFailedError | undefined = await t.throwsAsync(executeWorkflow(childWorkflowFailure), {
      instanceOf: WorkflowFailedError,
    });

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
});

const childExecutionQuery = defineQuery<WorkflowExecution | undefined>('childExecution');
export async function childWorkflowTermination(): Promise<void> {
  let workflowExecution: WorkflowExecution | undefined = undefined;
  setHandler(childExecutionQuery, () => workflowExecution);

  const child = await startChild(workflows.unblockOrCancel, {});
  workflowExecution = { workflowId: child.workflowId, runId: child.firstExecutionRunId };
  await child.result();
}

test('child-workflow-termination', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(childWorkflowTermination);
  const client = env.client;

  let childExecution: WorkflowExecution | undefined = undefined;

  await worker.runUntil(async () => {
    const err: WorkflowFailedError | undefined = await t.throwsAsync(
      async () => {
        while (childExecution === undefined) {
          childExecution = await handle.query(childExecutionQuery);
        }
        const child = client.workflow.getHandle(childExecution.workflowId!, childExecution.runId!);
        await child.terminate();
        await handle.result();
      },
      {
        instanceOf: WorkflowFailedError,
      }
    );

    if (!(err?.cause instanceof ChildWorkflowFailure)) {
      return t.fail('Expected err.cause to be an instance of ChildWorkflowFailure');
    }
    t.is(err.cause.retryState, RetryState.NON_RETRYABLE_FAILURE);
    if (!(err.cause.cause instanceof TerminatedFailure)) {
      return t.fail('Expected err.cause.cause to be an instance of TerminatedFailure');
    }
  });
});

export async function childWorkflowTimeout(): Promise<void> {
  await executeChild(workflows.unblockOrCancel, {
    workflowExecutionTimeout: '10ms',
    retry: { maximumAttempts: 1 },
  });
}

test('child-workflow-timeout', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const err: WorkflowFailedError | undefined = await t.throwsAsync(
    worker.runUntil(executeWorkflow(childWorkflowTimeout)),
    {
      instanceOf: WorkflowFailedError,
    }
  );

  if (!(err?.cause instanceof ChildWorkflowFailure)) {
    return t.fail('Expected err.cause to be an instance of ChildWorkflowFailure');
  }
  t.is(err.cause.retryState, RetryState.TIMEOUT);
  if (!(err.cause.cause instanceof TimeoutFailure)) {
    return t.fail('Expected err.cause.cause to be an instance of TimeoutFailure');
  }
  t.is(err.cause.cause.timeoutType, TimeoutType.START_TO_CLOSE);
});

export async function childWorkflowStartFail(): Promise<void> {
  const child = await startChild(workflows.successString, {
    workflowIdReusePolicy: 'REJECT_DUPLICATE',
  });
  await child.result();

  try {
    await startChild(workflows.successString, {
      taskQueue: 'test',
      workflowId: child.workflowId, // duplicate
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
    });
    throw new Error('Managed to start a Workflow with duplicate workflowId');
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
      throw new Error(`Got invalid error: ${err}`);
    }
  }
}

test('child-workflow-start-fail', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  await worker.runUntil(executeWorkflow(childWorkflowStartFail));
  // Assertions in workflow code
  t.pass();
});

test('child-workflow-cancel', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  await worker.runUntil(executeWorkflow(workflows.childWorkflowCancel));
  // Assertions in workflow code
  t.pass();
});

test('child-workflow-signals', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  await worker.runUntil(executeWorkflow(workflows.childWorkflowSignals));
  // Assertions in workflow code
  t.pass();
});

test('query not found', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.unblockOrCancel);
  await worker.runUntil(async () => {
    await handle.signal(workflows.unblockSignal);
    await handle.result();
    await t.throwsAsync(handle.query('not found'), {
      instanceOf: QueryNotRegisteredError,
      message:
        'Workflow did not register a handler for not found. Registered queries: [__stack_trace __enhanced_stack_trace __temporal_workflow_metadata isBlocked]',
    });
  });
});

test('query and unblock', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.unblockOrCancel);
  await worker.runUntil(async () => {
    t.true(await handle.query(workflows.isBlockedQuery));
    await handle.signal(workflows.unblockSignal);
    await handle.result();
    t.false(await handle.query(workflows.isBlockedQuery));
  });
});

test('interrupt-signal', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.interruptableWorkflow);
  await worker.runUntil(async () => {
    await handle.signal(workflows.interruptSignal, 'just because');
    const err: WorkflowFailedError | undefined = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });
    if (!(err?.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.message, 'just because');
  });
});

test('fail-signal', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.failSignalWorkflow);
  await worker.runUntil(async () => {
    await handle.signal(workflows.failSignal);
    const err: WorkflowFailedError | undefined = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });
    if (!(err?.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.message, 'Signal failed');
  });
});

test('async-fail-signal', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.asyncFailSignalWorkflow);
  await handle.signal(workflows.failSignal);
  await worker.runUntil(async () => {
    const err: WorkflowFailedError | undefined = await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    });
    if (!(err?.cause instanceof ApplicationFailure)) {
      return t.fail('Expected err.cause to be an instance of ApplicationFailure');
    }
    t.is(err.cause.message, 'Signal failed');
  });
});

test('http', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t, { activities });
  const res = await worker.runUntil(executeWorkflow(workflows.http));
  t.deepEqual(res, await activities.httpGet('https://temporal.io'));
});

test('sleep', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.sleeper);
  const res = await worker.runUntil(handle.result());
  t.is(res, undefined);
  const history = await handle.fetchHistory();
  const timerEvents = history.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
  t.is(timerEvents.length, 2);
  t.is(timerEvents[0].timerStartedEventAttributes!.timerId, '1');
  t.is(tsToMs(timerEvents[0].timerStartedEventAttributes!.startToFireTimeout), 100);
  t.is(timerEvents[1].timerFiredEventAttributes!.timerId, '1');
});

test('cancel-timer-immediately', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.cancelTimer);
  const res = await worker.runUntil(handle.result());
  t.is(res, undefined);
  const history = await handle.fetchHistory();
  const timerEvents = history.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
  // Timer is cancelled before it is scheduled
  t.is(timerEvents.length, 0);
});

export async function cancelTimerWithDelay(): Promise<void> {
  const scope = new CancellationScope();
  const promise = scope.run(() => sleep(10000));
  await sleep(1).then(() => scope.cancel());
  try {
    await promise;
  } catch (e) {
    if (e instanceof CancelledFailure) {
      console.log('Timer cancelled 👍');
    } else {
      throw e;
    }
  }
}

test('cancel-timer-with-delay', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(cancelTimerWithDelay);
  const res = await worker.runUntil(handle.result());
  t.is(res, undefined);
  const history = await handle.fetchHistory();
  const timerEvents = history.events!.filter(({ eventType }) => timerEventTypes.has(eventType!));
  t.is(timerEvents.length, 4);
  t.is(timerEvents[0].timerStartedEventAttributes!.timerId, '1');
  t.is(tsToMs(timerEvents[0].timerStartedEventAttributes!.startToFireTimeout), 10000);
  t.is(timerEvents[1].timerStartedEventAttributes!.timerId, '2');
  t.is(tsToMs(timerEvents[1].timerStartedEventAttributes!.startToFireTimeout), 1);
  t.is(timerEvents[2].timerFiredEventAttributes!.timerId, '2');
  t.is(timerEvents[3].timerCanceledEventAttributes!.timerId, '1');
});

test('patched', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.patchedWorkflow);
  const res = await worker.runUntil(handle.result());
  t.is(res, undefined);
  const history = await handle.fetchHistory();
  const hasChangeEvents = history.events!.filter(
    ({ eventType }) => eventType === iface.temporal.api.enums.v1.EventType.EVENT_TYPE_MARKER_RECORDED
  );
  // There will only be one marker despite there being 2 hasChange calls because they have the
  // same ID and core will only record one marker per id.
  t.is(hasChangeEvents.length, 1);
  t.is(hasChangeEvents[0].markerRecordedEventAttributes!.markerName, CHANGE_MARKER_NAME);
});

test('deprecate-patch', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.deprecatePatchWorkflow);
  const res = await worker.runUntil(handle.result());
  t.is(res, undefined);
  const history = await handle.fetchHistory();
  const hasChangeEvents = history.events!.filter(
    ({ eventType }) => eventType === iface.temporal.api.enums.v1.EventType.EVENT_TYPE_MARKER_RECORDED
  );
  t.is(hasChangeEvents.length, 1);
  t.is(hasChangeEvents[0].markerRecordedEventAttributes!.markerName, CHANGE_MARKER_NAME);
});

test('Worker default ServerOptions are generated correctly', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.argsAndReturn, {
    args: ['hey', undefined, Buffer.from('abc')],
  });
  await worker.runUntil(handle.result());
  const history = await handle.fetchHistory();
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

test('WorkflowHandle.describe result is wrapped', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const date = new Date();
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.argsAndReturn, {
    args: ['hey', undefined, Buffer.from('abc')],
    searchAttributes: {
      CustomKeywordField: ['test-value'],
      CustomIntField: [1],
      CustomDatetimeField: [date],
    },
    memo: {
      note: 'foo',
    },
  });
  await worker.runUntil(handle.result());
  const execution = await handle.describe();
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
    t.deepEqual(execution.searchAttributes!.BuildIds, ['unversioned', `unversioned:${worker.options.buildId}`]);
  }
});

export async function returnSearchAttributes(): Promise<SearchAttributes | undefined> {
  const sa = workflowInfo().searchAttributes!; // eslint-disable-line @typescript-eslint/no-non-null-assertion
  const datetime = (sa.CustomDatetimeField as Array<Date>)[0];
  return {
    ...sa,
    datetimeType: [Object.getPrototypeOf(datetime).constructor.name],
    datetimeInstanceofWorks: [datetime instanceof Date],
    arrayInstanceofWorks: [sa.CustomIntField instanceof Array],
  };
}

test('Workflow can read Search Attributes set at start', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const date = new Date();
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(returnSearchAttributes, {
    searchAttributes: {
      CustomKeywordField: ['test-value'],
      CustomIntField: [1],
      CustomDatetimeField: [date],
    },
  });
  const res = await worker.runUntil(handle.result());
  t.deepEqual(res, {
    CustomKeywordField: ['test-value'],
    CustomIntField: [1],
    CustomDatetimeField: [date.toISOString()],
    datetimeInstanceofWorks: [true],
    arrayInstanceofWorks: [true],
    datetimeType: ['Date'],
  });
});

test('Workflow can upsert Search Attributes', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const date = new Date();
  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(workflows.upsertAndReadSearchAttributes, {
    args: [date.getTime()],
  });
  const res = await worker.runUntil(handle.result());
  t.deepEqual(res, {
    CustomBoolField: [true],
    CustomIntField: [], // clear
    CustomKeywordField: ['durable code'],
    CustomTextField: ['is useful'],
    CustomDatetimeField: [date.toISOString()],
    CustomDoubleField: [3.14],
  });
  const { searchAttributes } = await handle.describe();
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

export async function returnWorkflowInfo(): Promise<WorkflowInfo> {
  return workflowInfo();
}

test('Workflow can read WorkflowInfo', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { startWorkflow, taskQueue } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(returnWorkflowInfo, {
    memo: {
      nested: { object: true },
    },
  });
  const res = await worker.runUntil(handle.result());
  t.assert(res.historySize > 100);
  t.deepEqual(res, {
    memo: {
      nested: { object: true },
    },
    attempt: 1,
    firstExecutionRunId: handle.firstExecutionRunId,
    namespace: 'default',
    taskTimeoutMs: 10_000,
    runId: handle.firstExecutionRunId,
    taskQueue,
    searchAttributes: {},
    workflowType: 'returnWorkflowInfo',
    workflowId: handle.workflowId,
    historyLength: 3,
    continueAsNewSuggested: false,
    // values ignored for the purpose of comparison
    historySize: res.historySize,
    startTime: res.startTime,
    runStartTime: res.runStartTime,
    currentBuildId: res.currentBuildId,
    // unsafe.now is a function, so doesn't make it through serialization, but .now is required, so we need to cast
    unsafe: { isReplaying: false } as UnsafeWorkflowInfo,
  });
});

test('WorkflowOptions are passed correctly with defaults', configMacro, async (t, config) => {
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

test('WorkflowOptions are passed correctly', configMacro, async (t, config) => {
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
  t.deepEqual(execution.searchAttributes!.CustomIntField, [3]);
  t.is(execution.raw.executionConfig?.taskQueue?.name, 'diff-task-queue');
  t.is(
    execution.raw.executionConfig?.taskQueue?.kind,
    iface.temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_NORMAL
  );

  t.is(tsToMs(execution.raw.executionConfig!.workflowRunTimeout!), msToNumber(options.workflowRunTimeout));
  t.is(tsToMs(execution.raw.executionConfig!.workflowExecutionTimeout!), msToNumber(options.workflowExecutionTimeout));
  t.is(tsToMs(execution.raw.executionConfig!.defaultWorkflowTaskTimeout!), msToNumber(options.workflowTaskTimeout));
});

test('WorkflowHandle.result() throws if terminated', configMacro, async (t, config) => {
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

test('WorkflowHandle.result() throws if continued as new', configMacro, async (t, config) => {
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

test('WorkflowHandle.result() follows chain of execution', configMacro, async (t, config) => {
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

test('continue-as-new-to-different-workflow', configMacro, async (t, config) => {
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

test('continue-as-new-to-same-workflow keeps memo and search attributes', configMacro, async (t, config) => {
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
    t.deepEqual(execution.searchAttributes!.CustomKeywordField, ['test-value']);
    t.deepEqual(execution.searchAttributes!.CustomIntField, [1]);
  });
});

test(
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
      t.deepEqual(info.searchAttributes!.CustomKeywordField, ['test-value']);
      t.deepEqual(info.searchAttributes!.CustomIntField, [1]);
    });
  }
);

test('continue-as-new-to-different-workflow can set memo and search attributes', configMacro, async (t, config) => {
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
    t.deepEqual(info.searchAttributes!.CustomKeywordField, ['test-value-2']);
    t.deepEqual(info.searchAttributes!.CustomIntField, [3]);
  });
});

test('signalWithStart works as intended and returns correct runId', configMacro, async (t, config) => {
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

test('activity-failures', configMacro, async (t, config) => {
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

test('sleepInvalidDuration is caught in Workflow runtime', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;

  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  await worker.runUntil(executeWorkflow(sleepInvalidDuration));
  t.pass();
});

test('unhandledRejection causes WFT to fail', configMacro, async (t, config) => {
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
        t.is(failure.message, 'unhandled rejection');
        t.true(failure.stackTrace?.includes(`Error: unhandled rejection`));
        t.is(failure.cause?.message, 'root failure');
      },
      { minTimeout: 300, factor: 1, retries: 100 }
    )
  );
  await handle.terminate();
});

export async function throwObject(): Promise<void> {
  throw { plainObject: true };
}

test('throwObject includes message with our recommendation', configMacro, async (t, config) => {
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

test('throwBigInt includes message with our recommendation', configMacro, async (t, config) => {
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

test('Workflow RetryPolicy kicks in with retryable failure', configMacro, async (t, config) => {
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

test('Workflow RetryPolicy ignored with nonRetryable failure', configMacro, async (t, config) => {
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

test('WorkflowClient.start fails with WorkflowExecutionAlreadyStartedError', configMacro, async (t, config) => {
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

test(
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

test('Handle from WorkflowClient.start follows only own execution chain', configMacro, async (t, config) => {
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

test('Handle from WorkflowClient.signalWithStart follows only own execution chain', configMacro, async (t, config) => {
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
});

test('Handle from WorkflowClient.getHandle follows only own execution chain', configMacro, async (t, config) => {
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

test('Handle from WorkflowClient.start terminates run after continue as new', configMacro, async (t, config) => {
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
    await handleFromStart.terminate();
    await t.throwsAsync(handleFromStart.result(), { message: 'Workflow execution terminated' });
  });
});

test(
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

test(
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

// TODO(thomas): fix
/*
if ('promiseHooks' in v8) {
  // Skip in old node versions
  test('Stack trace query returns stack that makes sense', configMacro, async (t, config) => {
    const { env, createWorkerWithDefaults } = config;

    const { executeWorkflow, createWorker } = configurableHelpers(t, t.context.workflowBundle, env);
    const worker = await createWorkerWithDefaults(t, { activities });
    const rawStacks = await worker.runUntil(executeWorkflow(workflows.stackTracer));

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
  
  
  test('Enhanced stack trace returns trace that makes sense', configMacro, async (t, config) => {
    const { env, createWorkerWithDefaults } = config;

    const { executeWorkflow, createWorker } = configurableHelpers(t, t.context.workflowBundle, env);
    const worker = await createWorkerWithDefaults(t, { activities });
    const enhancedStack = await worker.runUntil(executeWorkflow(workflows.enhancedStackTracer));

    const stacks = enhancedStack.stacks.map((s) => ({
      locations: s.locations.map((l) => ({
        ...l,
        ...(l.file_path
          ? { file_path: l.file_path.replace(path.resolve(__dirname, '../../../'), '').replace(/\\/g, '/') }
          : undefined),
      })),
    }));
    t.is(enhancedStack.sdk.name, 'typescript');
    t.is(enhancedStack.sdk.version, pkg.version); // Expect workflow and worker versions to match
    t.deepEqual(stacks, [
      {
        locations: [
          {
            function_name: 'Function.all',
            internal_code: false,
          },
          {
            file_path: '/packages/test/src/workflows/stack-tracer.ts',
            function_name: 'enhancedStackTracer',
            line: 32,
            column: 35,
            internal_code: false,
          },
        ],
      },
      {
        locations: [
          {
            file_path: '/packages/test/src/workflows/stack-tracer.ts',
            function_name: 'enhancedStackTracer',
            line: 32,
            column: 35,
            internal_code: false,
          },
        ],
      },
      {
        locations: [
          {
            function_name: 'Promise.then',
            internal_code: false,
          },
          {
            file_path: '/packages/workflow/src/trigger.ts',
            function_name: 'Trigger.then',
            line: 47,
            column: 24,
            internal_code: false,
          },
        ],
      },
    ]);
    const expectedSources = ['../src/workflows/stack-tracer.ts', '../../workflow/src/trigger.ts'].map((p) => [
      path.resolve(__dirname, p),
      [{ content: readFileSync(path.resolve(__dirname, p), 'utf8'), line_offset: 0 }],
    ]);
    t.deepEqual(Object.entries(enhancedStack.sources), expectedSources);
  });
}
*/

const mutateWorkflowStateQuery = defineQuery<void>('mutateWorkflowState');
export async function queryAndCondition(): Promise<void> {
  let mutated = false;
  // Not a valid query, used to verify that condition isn't triggered for query jobs
  setHandler(mutateWorkflowStateQuery, () => void (mutated = true));
  await condition(() => mutated);
}

test('Query does not cause condition to be triggered', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;

  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t);
  const handle = await startWorkflow(queryAndCondition);
  await worker.runUntil(handle.query(mutateWorkflowStateQuery));
  await handle.terminate();
  // Worker did not crash
  t.pass();
});

/**
 * NOTE: this test uses the `IN` operator API which requires advanced visibility as of server 1.18.
 * It will silently succeed on servers that only support standard visibility (can't dynamically skip a test).
 */
test('Download and replay multiple executions with client list method', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;

  const { startWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t, { activities });
  const client = env.client;
  try {
    const fns = [workflows.http, workflows.cancelFakeProgress, childWorkflowInvoke, workflows.activityFailures];
    const handles = await Promise.all(fns.map((fn) => startWorkflow(fn)));
    // Wait for the workflows to complete first
    await worker.runUntil(Promise.all(handles.map((h) => h.result())));
    // Test the list API too while we're at it
    const workflowIds = handles.map(({ workflowId }) => `'${workflowId}'`);
    const histories = client.workflow.list({ query: `WorkflowId IN (${workflowIds.join(', ')})` }).intoHistories();
    const results = Worker.runReplayHistories(
      {
        workflowBundle: worker.options.workflowBundle,
        dataConverter: env.options.client.dataConverter,
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
