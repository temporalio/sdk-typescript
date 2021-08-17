import anyTest, { TestInterface, ExecutionContext } from 'ava';
import path from 'path';
import Long from 'long';
import dedent from 'dedent';
import { coresdk } from '@temporalio/proto';
import { ApplyMode } from '@temporalio/workflow';
import { defaultDataConverter, ApplicationFailure, errorToFailure, msToTs, RetryState } from '@temporalio/common';
import { Workflow } from '@temporalio/worker/lib/workflow';
import { WorkflowIsolateBuilder } from '@temporalio/worker/lib/isolate-builder';
import { RoundRobinIsolateContextProvider } from '@temporalio/worker/lib/isolate-context-provider';
import { DefaultLogger } from '@temporalio/worker/lib/logger';
import * as activityFunctions from './activities';
import * as failureTesterActivityFunctions from './activities/failure-tester';
import { u8 } from './helpers';

export interface Context {
  workflow: Workflow;
  logs: unknown[][];
  script: string;
  contextProvider: RoundRobinIsolateContextProvider;
}

const test = anyTest as TestInterface<Context>;

test.before(async (t) => {
  const logger = new DefaultLogger('INFO');
  const workflowsPath = path.join(__dirname, 'workflows');
  const nodeModulesPath = path.join(__dirname, '../../../node_modules');
  const activities = new Map<string, Record<string, any>>([
    ['@activities', activityFunctions],
    ['@activities/failure-tester', failureTesterActivityFunctions],
  ]);
  const builder = new WorkflowIsolateBuilder(logger, nodeModulesPath, workflowsPath, activities);
  t.context.contextProvider = await RoundRobinIsolateContextProvider.create(builder, 1, 1024);
});

test.after.always((t) => {
  t.context.contextProvider.destroy();
});

test.beforeEach(async (t) => {
  const { contextProvider } = t.context;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const testName = t.title.match(/\S+$/)![0];
  const workflow = await Workflow.create(
    await contextProvider.getContext(),
    {
      filename: testName,
      runId: 'test-runId',
      workflowId: 'test-workflowId',
      namespace: 'default',
      taskQueue: 'test',
      isReplaying: false,
    },
    { type: 'remote', startToCloseTimeout: '10m' },
    [],
    Long.fromInt(1337),
    100
  );
  const logs: unknown[][] = [];
  await workflow.injectGlobal('console.log', (...args: unknown[]) => void logs.push(args), ApplyMode.SYNC);
  t.context = { workflow, logs, script: testName, contextProvider };
});

async function activate(t: ExecutionContext<Context>, activation: coresdk.workflow_activation.IWFActivation) {
  const arr = await t.context.workflow.activate(activation);
  const completion = coresdk.workflow_completion.WFActivationCompletion.decodeDelimited(arr);
  t.deepEqual(completion.runId, t.context.workflow.info.runId);
  return completion;
}

function compareCompletion(
  t: ExecutionContext<Context>,
  req: coresdk.workflow_completion.WFActivationCompletion,
  expected: coresdk.workflow_completion.IWFActivationCompletion
) {
  t.deepEqual(
    req.toJSON(),
    new coresdk.workflow_completion.WFActivationCompletion({
      ...expected,
      runId: t.context.workflow.info.runId,
    }).toJSON()
  );
}

function makeSuccess(
  commands: coresdk.workflow_commands.IWorkflowCommand[] = [makeCompleteWorkflowExecution()]
): coresdk.workflow_completion.IWFActivationCompletion {
  return { successful: { commands } };
}

function makeStartWorkflow(
  script: string,
  args?: coresdk.common.IPayload[],
  timestamp: number = Date.now()
): coresdk.workflow_activation.IWFActivation {
  return {
    runId: 'test-runId',
    timestamp: msToTs(timestamp),
    jobs: [{ startWorkflow: { workflowId: 'test-workflowId', workflowType: script, arguments: args } }],
  };
}

/**
 * Creates a Failure object for a cancelled activity
 */
function makeActivityCancelledFailure(activityId: string, activityType: [string, string]) {
  return {
    cause: {
      canceledFailureInfo: {},
    },
    activityFailureInfo: {
      activityId,
      identity: 'test',
      activityType: { name: JSON.stringify(activityType) },
      retryState: RetryState.RETRY_STATE_CANCEL_REQUESTED,
    },
  };
}
function makeActivation(
  timestamp: number = Date.now(),
  ...jobs: coresdk.workflow_activation.IWFActivationJob[]
): coresdk.workflow_activation.IWFActivation {
  return {
    runId: 'test-runId',
    timestamp: msToTs(timestamp),
    jobs,
  };
}

function makeFireTimer(timerId: string, timestamp: number = Date.now()): coresdk.workflow_activation.IWFActivation {
  return makeActivation(timestamp, makeFireTimerJob(timerId));
}

function makeFireTimerJob(timerId: string): coresdk.workflow_activation.IWFActivationJob {
  return {
    fireTimer: { timerId },
  };
}

function makeResolveActivityJob(
  activityId: string,
  result: coresdk.activity_result.IActivityResult
): coresdk.workflow_activation.IWFActivationJob {
  return {
    resolveActivity: { activityId, result },
  };
}

function makeResolveActivity(
  activityId: string,
  result: coresdk.activity_result.IActivityResult,
  timestamp: number = Date.now()
): coresdk.workflow_activation.IWFActivation {
  return makeActivation(timestamp, makeResolveActivityJob(activityId, result));
}

async function makeQueryWorkflow(
  queryId: string,
  queryType: string,
  queryArgs: any[],
  timestamp: number = Date.now()
): Promise<coresdk.workflow_activation.IWFActivation> {
  return makeActivation(timestamp, await makeQueryWorkflowJob(queryId, queryType, ...queryArgs));
}

async function makeQueryWorkflowJob(
  queryId: string,
  queryType: string,
  ...queryArgs: any[]
): Promise<coresdk.workflow_activation.IWFActivationJob> {
  return {
    queryWorkflow: {
      queryId,
      queryType,
      arguments: await defaultDataConverter.toPayloads(...queryArgs),
    },
  };
}

async function makeSignalWorkflow(
  signalName: string,
  args: any[],
  timestamp: number = Date.now()
): Promise<coresdk.workflow_activation.IWFActivation> {
  return makeActivation(timestamp, {
    signalWorkflow: { signalName, input: await defaultDataConverter.toPayloads(...args) },
  });
}

function makeCompleteWorkflowExecution(result?: coresdk.common.IPayload): coresdk.workflow_commands.IWorkflowCommand {
  result ??= { metadata: { encoding: u8('binary/null') } };
  return {
    completeWorkflowExecution: { result },
  };
}

function makeFailWorkflowExecution(
  message: string,
  stackTrace: string,
  type = 'Error'
): coresdk.workflow_commands.IWorkflowCommand {
  return {
    failWorkflowExecution: {
      failure: { message, stackTrace, applicationFailureInfo: { type, nonRetryable: false }, source: 'NodeSDK' },
    },
  };
}

function makeScheduleActivityCommand(
  attrs: coresdk.workflow_commands.IScheduleActivity
): coresdk.workflow_commands.IWorkflowCommand {
  return {
    scheduleActivity: attrs,
  };
}

function makeCancelActivityCommand(activityId: string, _reason?: string): coresdk.workflow_commands.IWorkflowCommand {
  return {
    requestCancelActivity: { activityId },
  };
}

function makeStartTimerCommand(
  attrs: coresdk.workflow_commands.IStartTimer
): coresdk.workflow_commands.IWorkflowCommand {
  return {
    startTimer: attrs,
  };
}

function makeCancelTimerCommand(
  attrs: coresdk.workflow_commands.ICancelTimer
): coresdk.workflow_commands.IWorkflowCommand {
  return {
    cancelTimer: attrs,
  };
}

function makeRespondToQueryCommand(
  respondToQuery: coresdk.workflow_commands.IQueryResult
): coresdk.workflow_commands.IWorkflowCommand {
  return {
    respondToQuery,
  };
}

test('random', async (t) => {
  const { logs, script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(1) })]));
  }
  {
    const req = await activate(
      t,
      makeActivation(
        undefined,
        { updateRandomSeed: { randomnessSeed: Long.fromNumber(7331) } },
        { fireTimer: { timerId: '0' } }
      )
    );
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [[0.8380154962651432], ['a50eca73-ff3e-4445-a512-2330c2f4f86e'], [0.18803317612037063]]);
});

test('sync', async (t) => {
  const { script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(
    t,
    req,
    makeSuccess([
      makeCompleteWorkflowExecution({
        metadata: { encoding: u8('json/plain') },
        data: u8(JSON.stringify('success')),
      }),
    ])
  );
});

/**
 * Replace path specifics from stack trace
 */
function cleanStackTrace(stack: string) {
  return stack.replace(/\bat ((async )?\S+)(:\d+:\d+| \(.*\))/g, (_, m0) => `at ${m0}`);
}

function cleanWorkflowFailureStackTrace(req: coresdk.workflow_completion.WFActivationCompletion, commandIndex = 0) {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  req.successful!.commands![commandIndex].failWorkflowExecution!.failure!.stackTrace = cleanStackTrace(
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    req.successful!.commands![commandIndex].failWorkflowExecution!.failure!.stackTrace!
  );
  return req;
}

function cleanWorkflowQueryFailureStackTrace(
  req: coresdk.workflow_completion.WFActivationCompletion,
  commandIndex = 0
) {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  req.successful!.commands![commandIndex].respondToQuery!.failed!.stackTrace = cleanStackTrace(
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    req.successful!.commands![commandIndex].respondToQuery!.failed!.stackTrace!
  );
  return req;
}

test('throw-sync', async (t) => {
  const { script } = t.context;
  const req = cleanWorkflowFailureStackTrace(await activate(t, makeStartWorkflow(script)));
  compareCompletion(
    t,
    req,
    makeSuccess([
      makeFailWorkflowExecution(
        'failure',
        dedent`
        Error: failure
            at Object.main
        `
      ),
    ])
  );
});

test('throw-async', async (t) => {
  const { script } = t.context;
  const req = cleanWorkflowFailureStackTrace(await activate(t, makeStartWorkflow(script)));
  compareCompletion(
    t,
    req,
    makeSuccess([
      makeFailWorkflowExecution(
        'failure',
        dedent`
        Error: failure
            at Object.main
        `
      ),
    ])
  );
});

test('date', async (t) => {
  const { logs, script } = t.context;
  const now = Date.now();
  const req = await activate(t, makeStartWorkflow(script, undefined, now));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[now], [now], [true]]);
});

test('async-workflow', async (t) => {
  const { logs, script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [['async']]);
});

test('deferred-resolve', async (t) => {
  const { logs, script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[1], [2]]);
});

test('sleep', async (t) => {
  const { logs, script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(100) })]));
  }
  {
    const req = await activate(t, makeFireTimer('0'));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['slept']]);
});

test('set-timeout-after-microtasks', async (t) => {
  const { logs, script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(100) })]));
  }
  {
    const req = await activate(t, makeFireTimer('0'));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['slept']]);
});

test('promise-then-promise', async (t) => {
  const { logs, script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[2]]);
});

test('reject-promise', async (t) => {
  const { logs, script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[true], [true]]);
});

test('promise-all', async (t) => {
  const { logs, script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[1, 2, 3], [1, 2, 3], [1, 2, 3], ['wow']]);
});

test('tasks-and-microtasks', async (t) => {
  const { logs, script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(0) })]));
  }
  {
    const req = await activate(t, makeFireTimer('0'));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['script start'], ['script end'], ['promise1'], ['promise2'], ['setTimeout']]);
});

test('trailing-timer', async (t) => {
  const { logs, script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(1) }),
        makeStartTimerCommand({ timerId: '1', startToFireTimeout: msToTs(1) }),
      ])
    );
  }
  {
    const req = await activate(t, makeActivation(undefined, makeFireTimerJob('0'), makeFireTimerJob('1')));
    // Note that the trailing timer does not get scheduled since the workflow completes
    // after the first timer is triggered causing the second one to be dropped.
    compareCompletion(
      t,
      req,
      makeSuccess([makeCompleteWorkflowExecution(await defaultDataConverter.toPayload('first'))])
    );
  }
  t.deepEqual(logs, []);
});

test('promise-race', async (t) => {
  const { logs, script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(20) }),
        makeStartTimerCommand({ timerId: '1', startToFireTimeout: msToTs(30) }),
      ])
    );
  }
  {
    const req = await activate(t, makeActivation(undefined, makeFireTimerJob('0'), makeFireTimerJob('1')));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [[1], [1], [1], [1], [20], ['wow']]);
});

test('race', async (t) => {
  const { logs, script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(10) }),
        makeStartTimerCommand({ timerId: '1', startToFireTimeout: msToTs(11) }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer('0'));
    compareCompletion(t, req, makeSuccess([]));
  }
  {
    const req = await activate(t, makeFireTimer('1'));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [[1], [2], [3]]);
});

test('importer', async (t) => {
  const { logs, script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(10) })]));
  }
  {
    const req = await activate(t, makeFireTimer('0'));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['slept']]);
});

test('external-importer', async (t) => {
  const { logs, script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[{ a: 1, b: 2 }]]);
});

test('args-and-return', async (t) => {
  const { script } = t.context;
  const req = await activate(
    t,
    makeStartWorkflow(script, [
      {
        metadata: { encoding: u8('json/plain') },
        data: u8(JSON.stringify('Hello')),
      },
      {
        metadata: { encoding: u8('binary/null') },
      },
      {
        metadata: { encoding: u8('binary/plain') },
        data: u8('world'),
      },
    ])
  );
  compareCompletion(
    t,
    req,
    makeSuccess([
      makeCompleteWorkflowExecution({
        metadata: { encoding: u8('json/plain') },
        data: u8(JSON.stringify('Hello, world')),
      }),
    ])
  );
});

test('simple-query', async (t) => {
  const { script } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, completion, makeSuccess([]));
  }
  {
    const completion = await activate(t, await makeQueryWorkflow('1', 'isBlocked', []));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeRespondToQueryCommand({
          queryId: '1',
          succeeded: { response: await defaultDataConverter.toPayload(true) },
        }),
      ])
    );
  }
  {
    const completion = await activate(t, await makeSignalWorkflow('unblock', []));
    compareCompletion(t, completion, makeSuccess());
  }
  {
    const completion = await activate(t, await makeQueryWorkflow('2', 'isBlocked', []));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeRespondToQueryCommand({
          queryId: '2',
          succeeded: { response: await defaultDataConverter.toPayload(false) },
        }),
      ])
    );
  }
  {
    const completion = cleanWorkflowQueryFailureStackTrace(await activate(t, await makeQueryWorkflow('3', 'fail', [])));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeRespondToQueryCommand({
          queryId: '3',
          failed: {
            source: 'NodeSDK',
            message: 'Query failed',
            stackTrace: dedent`
              Error: Query failed
                  at fail
                  at workflow-isolate
                  at Activator.queryWorkflow
                  at activate
            `,
            applicationFailureInfo: {
              type: 'Error',
              nonRetryable: false,
            },
          },
        }),
      ])
    );
  }
});

test('invalid-async-query-handler', async (t) => {
  const { script } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, completion, makeSuccess());
  }
  {
    const completion = cleanWorkflowQueryFailureStackTrace(
      await activate(t, await makeQueryWorkflow('3', 'invalidAsyncMethod', []))
    );
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeRespondToQueryCommand({
          queryId: '3',
          failed: {
            message: 'Query handlers should not return a Promise',
            source: 'NodeSDK',
            stackTrace: dedent`
              DeterminismViolationError: Query handlers should not return a Promise
                  at workflow-isolate
                  at Activator.queryWorkflow
                  at activate
            `,
            applicationFailureInfo: {
              type: 'DeterminismViolationError',
              nonRetryable: false,
            },
          },
        }),
      ])
    );
  }
});

test('interrupt-signal', async (t) => {
  const { script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, req, makeSuccess([]));
  }
  {
    const req = cleanWorkflowFailureStackTrace(
      await activate(t, await makeSignalWorkflow('interrupt', ['just because']))
    );
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeFailWorkflowExecution(
          'just because',
          // The stack trace is weird here and might confuse users, it might be a JS limitation
          // since the Error stack trace is generated in the constructor.
          dedent`
          Error: just because
              at interrupt
          `,
          'Error'
        ),
      ])
    );
  }
});

test('fail-signal', async (t) => {
  const { script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(100000) })])
    );
  }
  {
    const req = cleanWorkflowFailureStackTrace(await activate(t, await makeSignalWorkflow('fail', [])));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeFailWorkflowExecution(
          'Signal failed',
          dedent`
          Error: Signal failed
              at fail
          `,
          'Error'
        ),
      ])
    );
  }
});

test('async-fail-signal', async (t) => {
  const { script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(100000) })])
    );
  }
  {
    const req = await activate(t, await makeSignalWorkflow('fail', []));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '1', startToFireTimeout: msToTs(100) })]));
  }
  {
    const req = cleanWorkflowFailureStackTrace(await activate(t, makeFireTimer('1')));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeFailWorkflowExecution(
          'Signal failed',
          dedent`
          Error: Signal failed
              at fail`,
          'Error'
        ),
      ])
    );
  }
});

test('cancel-workflow', async (t) => {
  const url = 'https://temporal.io';
  const { script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script, await defaultDataConverter.toPayloads(url)));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '0',
          activityType: JSON.stringify(['@activities', 'httpGet']),
          arguments: await defaultDataConverter.toPayloads(url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const req = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(t, req, makeSuccess([makeCancelActivityCommand('0')]));
  }
  {
    const req = await activate(
      t,
      makeActivation(undefined, {
        resolveActivity: {
          activityId: '0',
          result: {
            cancelled: {
              failure: makeActivityCancelledFailure('0', ['@activities', 'httpGet']),
            },
          },
        },
      })
    );
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '2',
          activityType: JSON.stringify(['@activities', 'httpGet']),
          arguments: await defaultDataConverter.toPayloads(url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  const result = await defaultDataConverter.toPayload(await activityFunctions.httpGet(url));
  {
    const req = await activate(
      t,
      makeActivation(undefined, {
        resolveActivity: {
          activityId: '2',
          result: { completed: { result } },
        },
      })
    );
    compareCompletion(t, req, makeSuccess([makeCompleteWorkflowExecution(result)]));
  }
});

test('trigger-cancellation', async (t) => {
  const { script, logs } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, completion, makeSuccess([]));
  }
  {
    const completion = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(t, completion, makeSuccess());
  }
  t.deepEqual(logs, [['Blocked'], ['Cancelled']]);
});

test('cancel-timer-immediately', async (t) => {
  const { script, logs } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(
    t,
    req,
    makeSuccess([
      makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(1) }),
      makeCancelTimerCommand({ timerId: '0' }),
      makeCompleteWorkflowExecution(),
    ])
  );
  t.deepEqual(logs, [['Timer cancelled 👍']]);
});

test('cancel-timer-immediately-alternative-impl', async (t) => {
  const { script, logs } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(
    t,
    req,
    makeSuccess([
      makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(1) }),
      makeCancelTimerCommand({ timerId: '0' }),
      makeCompleteWorkflowExecution(),
    ])
  );
  t.deepEqual(logs, [['Timer cancelled 👍']]);
});

test('non-cancellable-shields-children', async (t) => {
  const { script } = t.context;
  const url = 'https://temporal.io';
  const result = await defaultDataConverter.toPayload({ test: true });
  {
    const completion = await activate(t, makeStartWorkflow(script, [await defaultDataConverter.toPayload(url)]));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '0',
          activityType: JSON.stringify(['@activities', 'httpGetJSON']),
          arguments: await defaultDataConverter.toPayloads(url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const completion = await activate(t, makeResolveActivity('0', { completed: { result } }));
    compareCompletion(t, completion, makeSuccess([makeCompleteWorkflowExecution(result)]));
  }
});

test('cancel-requested-with-non-cancellable', async (t) => {
  const { script } = t.context;
  const url = 'https://temporal.io';
  const result = await defaultDataConverter.toPayload({ test: true });
  {
    const completion = await activate(t, makeStartWorkflow(script, [await defaultDataConverter.toPayload(url)]));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '0',
          activityType: JSON.stringify(['@activities', 'httpGetJSON']),
          arguments: await defaultDataConverter.toPayloads(url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const completion = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(t, completion, makeSuccess([]));
  }
  {
    const completion = await activate(t, makeResolveActivity('0', { completed: { result } }));
    compareCompletion(t, completion, makeSuccess([makeCompleteWorkflowExecution(result)]));
  }
});

test('handle-external-workflow-cancellation-while-activity-running', async (t) => {
  const { script } = t.context;
  const url = 'https://temporal.io';
  const data = { content: 'new HTML content' };
  {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const completion = await activate(t, makeStartWorkflow(script, await defaultDataConverter.toPayloads(url, data)!));

    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '0',
          activityType: JSON.stringify(['@activities', 'httpPostJSON']),
          arguments: await defaultDataConverter.toPayloads(url, data),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const completion = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(t, completion, makeSuccess([makeCancelActivityCommand('0')]));
  }
  {
    const completion = await activate(
      t,
      makeResolveActivity('0', { cancelled: { failure: { canceledFailureInfo: {} } } })
    );
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '1',
          activityType: JSON.stringify(['@activities', 'cleanup']),
          arguments: await defaultDataConverter.toPayloads(url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const completion = await activate(
      t,
      makeResolveActivity('1', { completed: { result: await defaultDataConverter.toPayload(undefined) } })
    );
    compareCompletion(t, completion, makeSuccess([{ cancelWorkflowExecution: {} }]));
  }
});

test('nested-cancellation', async (t) => {
  const { script } = t.context;
  const url = 'https://temporal.io';
  {
    const completion = await activate(t, makeStartWorkflow(script, [await defaultDataConverter.toPayload(url)]));

    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '0',
          activityType: JSON.stringify(['@activities', 'setup']),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const completion = await activate(
      t,
      makeResolveActivity('0', { completed: { result: await defaultDataConverter.toPayload(undefined) } })
    );

    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeStartTimerCommand({ timerId: '1', startToFireTimeout: msToTs(1000) }),
        makeScheduleActivityCommand({
          activityId: '2',
          activityType: JSON.stringify(['@activities', 'httpPostJSON']),
          arguments: await defaultDataConverter.toPayloads(url, { some: 'data' }),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const completion = await activate(t, makeFireTimer('1'));
    compareCompletion(t, completion, makeSuccess([makeCancelActivityCommand('2')]));
  }
  const failure = makeActivityCancelledFailure('2', ['@activities', 'httpPostJSON']);
  {
    const completion = await activate(t, makeResolveActivity('2', { cancelled: { failure } }));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '3',
          activityType: JSON.stringify(['@activities', 'cleanup']),
          arguments: await defaultDataConverter.toPayloads(url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const completion = await activate(
      t,
      makeResolveActivity('3', { completed: { result: await defaultDataConverter.toPayload(undefined) } })
    );
    compareCompletion(
      t,
      completion,
      makeSuccess([
        {
          failWorkflowExecution: { failure },
        },
      ])
    );
  }
});

test('shared-promise-scopes', async (t) => {
  const { script } = t.context;
  const result = { some: 'data' };
  {
    const completion = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      completion,
      makeSuccess(
        await Promise.all(
          [0, 1].map(async (idx) =>
            makeScheduleActivityCommand({
              activityId: `${idx}`,
              activityType: JSON.stringify(['@activities', 'httpGetJSON']),
              arguments: await defaultDataConverter.toPayloads(`http://url${idx + 1}.ninja`),
              startToCloseTimeout: msToTs('10m'),
              taskQueue: 'test',
            })
          )
        )
      )
    );
  }
  {
    const completion = await activate(
      t,
      makeResolveActivity('1', { completed: { result: await defaultDataConverter.toPayload(result) } })
    );
    compareCompletion(
      t,
      completion,
      makeSuccess([makeCompleteWorkflowExecution(await defaultDataConverter.toPayload(result))])
    );
  }
});

test('shield-awaited-in-root-scope', async (t) => {
  const { script } = t.context;
  const result = { some: 'data' };
  {
    const completion = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '0',
          activityType: JSON.stringify(['@activities', 'httpGetJSON']),
          arguments: await defaultDataConverter.toPayloads(`http://example.com`),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    // Workflow ignores cancellation
    const completion = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(t, completion, makeSuccess([]));
  }
  {
    const completion = await activate(
      t,
      makeResolveActivity('0', { completed: { result: await defaultDataConverter.toPayload(result) } })
    );
    compareCompletion(
      t,
      completion,
      makeSuccess([makeCompleteWorkflowExecution(await defaultDataConverter.toPayload(result))])
    );
  }
});

test('cancellation-scopes-with-callbacks', async (t) => {
  const { script } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      completion,
      makeSuccess([makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(10) })])
    );
  }
  {
    const completion = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(t, completion, makeSuccess([{ cancelWorkflowExecution: {} }]));
  }
});

test('cancellation-scopes', async (t) => {
  const { script, logs } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(3) })]));
  }
  {
    const req = await activate(t, makeFireTimer('0'));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ timerId: '1', startToFireTimeout: msToTs(3) }),
        makeStartTimerCommand({ timerId: '2', startToFireTimeout: msToTs(3) }),
        makeCancelTimerCommand({ timerId: '1' }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer('2'));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '3', startToFireTimeout: msToTs(3) })]));
  }
  {
    const req = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(t, req, makeSuccess([makeCancelTimerCommand({ timerId: '3' }), makeCompleteWorkflowExecution()]));
  }
  t.deepEqual(logs, [
    ['Scope cancelled 👍'],
    ['Exception was propagated 👍'],
    ['Scope 2 was not cancelled 👍'],
    ['Scope cancelled 👍'],
    ['Exception was propagated 👍'],
  ]);
});

test('child-and-shield', async (t) => {
  const { script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(5) })]));
  }
  {
    const req = await activate(t, makeFireTimer('0'));
    compareCompletion(t, req, makeSuccess());
  }
});

test('partial-shield', async (t) => {
  const { script, logs } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(5) }),
        makeStartTimerCommand({ timerId: '1', startToFireTimeout: msToTs(3) }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer('1'));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '2', startToFireTimeout: msToTs(2) })]));
  }
  {
    const req = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeCancelTimerCommand({ timerId: '2' }),
        makeStartTimerCommand({ timerId: '3', startToFireTimeout: msToTs(10) }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer('0'));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '4', startToFireTimeout: msToTs(1) })]));
  }
  {
    const req = await activate(t, makeFireTimer('3'));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['Workflow cancelled']]);
});

test('shield-in-shield', async (t) => {
  const { script, logs } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(2) }),
        makeStartTimerCommand({ timerId: '1', startToFireTimeout: msToTs(1) }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer('1'));
    compareCompletion(t, req, makeSuccess([]));
  }
  {
    const req = await activate(t, makeFireTimer('0'));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['Timer 1 finished 👍'], ['Timer 0 finished 👍']]);
});

test('cancellation-error-is-propagated', async (t) => {
  const { script, logs } = t.context;
  const req = cleanWorkflowFailureStackTrace(await activate(t, makeStartWorkflow(script)), 2);
  compareCompletion(
    t,
    req,
    makeSuccess([
      makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(0) }),
      makeCancelTimerCommand({ timerId: '0' }),
      {
        failWorkflowExecution: {
          failure: {
            message: 'Cancellation scope cancelled',
            stackTrace: dedent`
        CancelledFailure: Cancellation scope cancelled
            at CancellationScope.cancel
            at workflow-isolate
            at workflow-isolate
            at AsyncLocalStorage.run
            at CancellationScope.run
            at Function.cancellable
            at Object.main
        `,
            canceledFailureInfo: {},
            source: 'NodeSDK',
          },
        },
      },
    ])
  );
  t.deepEqual(logs, []);
});

test('cancel-activity-after-first-completion', async (t) => {
  const url = 'https://temporal.io';
  const { script, logs } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script, await defaultDataConverter.toPayloads(url)));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '0',
          activityType: JSON.stringify(['@activities', 'httpGet']),
          arguments: await defaultDataConverter.toPayloads(url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const req = await activate(
      t,
      makeResolveActivity('0', { completed: { result: await defaultDataConverter.toPayload('response1') } })
    );
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '1',
          activityType: JSON.stringify(['@activities', 'httpGet']),
          arguments: await defaultDataConverter.toPayloads(url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const req = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(t, req, makeSuccess([]));
  }
  {
    const req = await activate(
      t,
      makeResolveActivity('1', { completed: { result: await defaultDataConverter.toPayload('response2') } })
    );
    compareCompletion(
      t,
      req,
      makeSuccess([makeCompleteWorkflowExecution(await defaultDataConverter.toPayload(['response1', 'response2']))])
    );
  }
  t.deepEqual(logs, [['Workflow cancelled while waiting on non cancellable scope']]);
});

test('multiple-activities-single-timeout', async (t) => {
  const urls = ['https://slow-site.com/', 'https://slow-site.org/'];
  const { script } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(script, await defaultDataConverter.toPayloads(urls, 1000)));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(1000) }),
        ...(await Promise.all(
          urls.map(async (url, index) =>
            makeScheduleActivityCommand({
              activityId: `${index + 1}`, // sequence 0 is taken by the timer
              activityType: JSON.stringify(['@activities', 'httpGetJSON']),
              arguments: await defaultDataConverter.toPayloads(url),
              startToCloseTimeout: msToTs('10m'),
              taskQueue: 'test',
            })
          )
        )),
      ])
    );
  }
  {
    const completion = await activate(t, makeFireTimer('0'));
    compareCompletion(t, completion, makeSuccess([makeCancelActivityCommand('1'), makeCancelActivityCommand('2')]));
  }
  const failure1 = makeActivityCancelledFailure('1', ['@activities', 'httpGetJSON']);
  const failure2 = makeActivityCancelledFailure('2', ['@activities', 'httpGetJSON']);
  {
    const completion = await activate(
      t,
      makeActivation(
        undefined,
        { resolveActivity: { activityId: '1', result: { cancelled: { failure: failure1 } } } },
        { resolveActivity: { activityId: '2', result: { cancelled: { failure: failure2 } } } }
      )
    );
    compareCompletion(t, completion, makeSuccess([{ failWorkflowExecution: { failure: failure1 } }]));
  }
});

test('http', async (t) => {
  const { script, logs } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '0',
          activityType: JSON.stringify(['@activities', 'httpGet']),
          arguments: await defaultDataConverter.toPayloads('https://google.com'),
          startToCloseTimeout: msToTs('10 minutes'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  const result = '<html><body>hello from https://google.com</body></html>';
  {
    const req = await activate(
      t,
      makeResolveActivity('0', { completed: { result: await defaultDataConverter.toPayload(result) } })
    );
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '1',
          activityType: JSON.stringify(['@activities', 'httpGet']),
          arguments: await defaultDataConverter.toPayloads('http://example.com'),
          scheduleToCloseTimeout: msToTs('30 minutes'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  const failure = ApplicationFailure.retryable('Connection timeout', 'MockError');
  failure.stack = failure.stack?.split('\n')[0];

  {
    const req = await activate(
      t,
      makeResolveActivity('1', {
        failed: {
          failure: await errorToFailure(failure, defaultDataConverter),
        },
      })
    );
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeFailWorkflowExecution(
          'Connection timeout',
          "ApplicationFailure: message='Connection timeout', type='MockError', nonRetryable=false",
          'MockError'
        ),
      ])
    );
  }
  t.deepEqual(logs, [[result]]);
});

test('activity-configure', async (t) => {
  const { script, logs } = t.context;
  const result = '<html><body>hello from https://example.com</body></html>';
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '0',
          activityType: JSON.stringify(['@activities', 'httpGet']),
          arguments: await defaultDataConverter.toPayloads('http://example.com'),
          startToCloseTimeout: msToTs('10 minutes'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const req = await activate(
      t,
      makeResolveActivity('0', { completed: { result: await defaultDataConverter.toPayload(result) } })
    );
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '1',
          activityType: JSON.stringify(['@activities', 'httpGet']),
          arguments: await defaultDataConverter.toPayloads('http://example.com'),
          heartbeatTimeout: msToTs('3s'),
          scheduleToCloseTimeout: msToTs('30 minutes'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const req = await activate(
      t,
      makeResolveActivity('1', { completed: { result: await defaultDataConverter.toPayload(result) } })
    );
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '2',
          activityType: JSON.stringify(['@activities', 'httpGet']),
          arguments: await defaultDataConverter.toPayloads('http://example.com'),
          scheduleToStartTimeout: msToTs('20 minutes'),
          startToCloseTimeout: msToTs('10 minutes'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const req = await activate(
      t,
      makeResolveActivity('2', { completed: { result: await defaultDataConverter.toPayload(result) } })
    );
    compareCompletion(
      t,
      req,
      makeSuccess([makeCompleteWorkflowExecution(await defaultDataConverter.toPayload([result, result, result]))])
    );
  }
  const errorMessage = 'TypeError: Required either scheduleToCloseTimeout or startToCloseTimeout';
  t.deepEqual(logs, [[errorMessage]]);
});

test('global-overrides', async (t) => {
  const { script, logs } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(
    logs,
    ['WeakMap' /* First error happens on startup */, 'WeakMap', 'WeakSet', 'WeakRef'].map((type) => [
      `DeterminismViolationError: ${type} cannot be used in workflows because v8 GC is non-deterministic`,
    ])
  );
});

test('log-before-timing-out', async (t) => {
  const { script, workflow } = t.context;
  const logs: string[] = [];
  await workflow.injectDependency('logger', 'info', (message: string) => logs.push(message), ApplyMode.ASYNC_IGNORED);
  await t.throwsAsync(activate(t, makeStartWorkflow(script)), { message: 'Script execution timed out.' });
  t.deepEqual(logs, ['logging before getting stuck']);
});

test('continue-as-new-same-workflow', async (t) => {
  const { script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([
        {
          continueAsNewWorkflowExecution: {
            workflowType: script,
            taskQueue: 'test',
            arguments: await defaultDataConverter.toPayloads('signal'),
          },
        },
      ])
    );
  }
});

test.todo('no-commands-can-be-issued-once-workflow-completes');
