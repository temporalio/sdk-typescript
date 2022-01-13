import anyTest, { ExecutionContext, TestInterface } from 'ava';
import vm from 'vm';
import path from 'path';
import Long from 'long';
import dedent from 'dedent';
import { coresdk } from '@temporalio/proto';
import { ApplicationFailure, defaultDataConverter, errorToFailure, msToTs, RetryState } from '@temporalio/common';
import { WorkflowCodeBundler } from '@temporalio/worker/lib/workflow/bundler';
import { VMWorkflow, VMWorkflowCreator } from '@temporalio/worker/lib/workflow/vm';
import { DefaultLogger } from '@temporalio/worker/lib/logger';
import * as activityFunctions from './activities';
import { u8 } from './helpers';
import { WorkflowInfo } from '@temporalio/workflow';

export interface Context {
  workflow: VMWorkflow;
  logs: unknown[][];
  workflowType: string;
  startTime: number;
  runId: string;
  workflowCreator: TestVMWorkflowCreator;
}

class TestVMWorkflowCreator extends VMWorkflowCreator {
  public logs: Record<string, unknown[][]> = {};

  override injectConsole(context: vm.Context, info: WorkflowInfo) {
    const { logs } = this;
    context.console = {
      log(...args: unknown[]) {
        logs[info.runId].push(args);
      },
    };
  }
}

const test = anyTest as TestInterface<Context>;

test.before(async (t) => {
  const logger = new DefaultLogger('INFO');
  const workflowsPath = path.join(__dirname, 'workflows');
  const nodeModulesPath = path.join(__dirname, '../../../node_modules');
  const bundler = new WorkflowCodeBundler(logger, [nodeModulesPath], workflowsPath);
  const bundle = await bundler.createBundle();
  t.context.workflowCreator = await TestVMWorkflowCreator.create(bundle, 100);
});

test.after.always(async (t) => {
  await t.context.workflowCreator.destroy();
});

test.beforeEach(async (t) => {
  const { workflowCreator } = t.context;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const workflowType = t.title.match(/\S+$/)![0];
  const runId = t.title;
  const logs = new Array<unknown[]>();
  workflowCreator.logs[runId] = logs;
  const startTime = Date.now();
  const workflow = await createWorkflow(workflowType, runId, startTime, workflowCreator);

  t.context = {
    logs,
    runId,
    workflowType,
    workflowCreator,
    startTime,
    workflow,
  };
});

async function createWorkflow(
  workflowType: string,
  runId: string,
  startTime: number,
  workflowCreator: VMWorkflowCreator
) {
  const workflow = (await workflowCreator.createWorkflow({
    info: {
      workflowType,
      runId,
      workflowId: 'test-workflowId',
      namespace: 'default',
      taskQueue: 'test',
      isReplaying: false,
    },
    randomnessSeed: Long.fromInt(1337).toBytes(),
    now: startTime,
    patches: [],
  })) as VMWorkflow;
  return workflow;
}

async function activate(t: ExecutionContext<Context>, activation: coresdk.workflow_activation.IWorkflowActivation) {
  const { workflow, runId } = t.context;
  const arr = await workflow.activate(activation);
  const completion = coresdk.workflow_completion.WorkflowActivationCompletion.decodeDelimited(arr);
  t.deepEqual(completion.runId, runId);
  return completion;
}

function compareCompletion(
  t: ExecutionContext<Context>,
  req: coresdk.workflow_completion.WorkflowActivationCompletion,
  expected: coresdk.workflow_completion.IWorkflowActivationCompletion
) {
  t.deepEqual(
    req.toJSON(),
    new coresdk.workflow_completion.WorkflowActivationCompletion({
      ...expected,
      runId: t.context.runId,
    }).toJSON()
  );
}

function makeSuccess(
  commands: coresdk.workflow_commands.IWorkflowCommand[] = [makeCompleteWorkflowExecution()]
): coresdk.workflow_completion.IWorkflowActivationCompletion {
  return { successful: { commands } };
}

function makeStartWorkflow(
  script: string,
  args?: coresdk.common.IPayload[],
  timestamp: number = Date.now()
): coresdk.workflow_activation.IWorkflowActivation {
  return makeActivation(timestamp, makeStartWorkflowJob(script, args));
}

function makeStartWorkflowJob(
  workflowType: string,
  args?: coresdk.common.IPayload[]
): { startWorkflow: coresdk.workflow_activation.IStartWorkflow } {
  return {
    startWorkflow: { workflowId: 'test-workflowId', workflowType, arguments: args },
  };
}

/**
 * Creates a Failure object for a cancelled activity
 */
function makeActivityCancelledFailure(activityId: string, activityType: string) {
  return {
    cause: {
      canceledFailureInfo: {},
    },
    activityFailureInfo: {
      activityId,
      identity: 'test',
      activityType: { name: activityType },
      retryState: RetryState.RETRY_STATE_CANCEL_REQUESTED,
    },
  };
}
function makeActivation(
  timestamp: number = Date.now(),
  ...jobs: coresdk.workflow_activation.IWorkflowActivationJob[]
): coresdk.workflow_activation.IWorkflowActivation {
  return {
    runId: 'test-runId',
    timestamp: msToTs(timestamp),
    jobs,
  };
}

function makeFireTimer(seq: number, timestamp: number = Date.now()): coresdk.workflow_activation.IWorkflowActivation {
  return makeActivation(timestamp, makeFireTimerJob(seq));
}

function makeFireTimerJob(seq: number): coresdk.workflow_activation.IWorkflowActivationJob {
  return {
    fireTimer: { seq },
  };
}

function makeResolveActivityJob(
  seq: number,
  result: coresdk.activity_result.IActivityExecutionResult
): coresdk.workflow_activation.IWorkflowActivationJob {
  return {
    resolveActivity: { seq, result },
  };
}

function makeResolveActivity(
  seq: number,
  result: coresdk.activity_result.IActivityExecutionResult,
  timestamp: number = Date.now()
): coresdk.workflow_activation.IWorkflowActivation {
  return makeActivation(timestamp, makeResolveActivityJob(seq, result));
}

function makeNotifyHasPatchJob(patchId: string): coresdk.workflow_activation.IWorkflowActivationJob {
  return {
    notifyHasPatch: { patchId },
  };
}

async function makeQueryWorkflow(
  queryId: string,
  queryType: string,
  queryArgs: any[],
  timestamp: number = Date.now()
): Promise<coresdk.workflow_activation.IWorkflowActivation> {
  return makeActivation(timestamp, await makeQueryWorkflowJob(queryId, queryType, ...queryArgs));
}

async function makeQueryWorkflowJob(
  queryId: string,
  queryType: string,
  ...queryArgs: any[]
): Promise<coresdk.workflow_activation.IWorkflowActivationJob> {
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
): Promise<coresdk.workflow_activation.IWorkflowActivation> {
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
  type = 'Error',
  nonRetryable = true
): coresdk.workflow_commands.IWorkflowCommand {
  return {
    failWorkflowExecution: {
      failure: { message, stackTrace, applicationFailureInfo: { type, nonRetryable }, source: 'TypeScriptSDK' },
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

function makeCancelActivityCommand(seq: number, _reason?: string): coresdk.workflow_commands.IWorkflowCommand {
  return {
    requestCancelActivity: { seq },
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

function makeSetPatchMarker(myPatchId: string, deprecated: boolean): coresdk.workflow_commands.IWorkflowCommand {
  return {
    setPatchMarker: {
      patchId: myPatchId,
      deprecated,
    },
  };
}

test('random', async (t) => {
  const { logs, workflowType } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(1) })]));
  }
  {
    const req = await activate(
      t,
      makeActivation(
        undefined,
        { updateRandomSeed: { randomnessSeed: Long.fromNumber(7331) } },
        { fireTimer: { seq: 1 } }
      )
    );
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [[0.8380154962651432], ['a50eca73-ff3e-4445-a512-2330c2f4f86e'], [0.18803317612037063]]);
});

test('successString', async (t) => {
  const { workflowType } = t.context;
  const req = await activate(t, makeStartWorkflow(workflowType));
  compareCompletion(
    t,
    req,
    makeSuccess([makeCompleteWorkflowExecution(defaultDataConverter.toPayloadSync('success'))])
  );
});

/**
 * Replace path specifics from stack trace
 */
function cleanStackTrace(stack: string) {
  return stack.replace(/\bat ((async )?\S+)(:\d+:\d+| \(.*\))/g, (_, m0) => `at ${m0}`);
}

function cleanWorkflowFailureStackTrace(
  req: coresdk.workflow_completion.WorkflowActivationCompletion,
  commandIndex = 0
) {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  req.successful!.commands![commandIndex].failWorkflowExecution!.failure!.stackTrace = cleanStackTrace(
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    req.successful!.commands![commandIndex].failWorkflowExecution!.failure!.stackTrace!
  );
  return req;
}

function cleanWorkflowQueryFailureStackTrace(
  req: coresdk.workflow_completion.WorkflowActivationCompletion,
  commandIndex = 0
) {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  req.successful!.commands![commandIndex].respondToQuery!.failed!.stackTrace = cleanStackTrace(
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    req.successful!.commands![commandIndex].respondToQuery!.failed!.stackTrace!
  );
  return req;
}

test('throwAsync', async (t) => {
  const { workflowType } = t.context;
  const req = cleanWorkflowFailureStackTrace(await activate(t, makeStartWorkflow(workflowType)));
  compareCompletion(
    t,
    req,
    makeSuccess([
      makeFailWorkflowExecution(
        'failure',
        dedent`
        ApplicationFailure: failure
            at Function.nonRetryable
            at throwAsync
        `
      ),
    ])
  );
});

test('date', async (t) => {
  const { startTime, logs, workflowType } = t.context;
  const req = await activate(t, makeStartWorkflow(workflowType, undefined, startTime));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[startTime], [startTime], [true], [true], [true], [true], [true]]);
});

test('asyncWorkflow', async (t) => {
  const { workflowType } = t.context;
  const req = await activate(t, makeStartWorkflow(workflowType));
  compareCompletion(t, req, makeSuccess([makeCompleteWorkflowExecution(defaultDataConverter.toPayloadSync('async'))]));
});

test('deferredResolve', async (t) => {
  const { logs, workflowType } = t.context;
  const req = await activate(t, makeStartWorkflow(workflowType));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[1], [2]]);
});

test('sleeper', async (t) => {
  const { logs, workflowType } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(100) })]));
  }
  {
    const req = await activate(t, makeFireTimer(1));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['slept']]);
});

test('with ms string - sleeper', async (t) => {
  const { logs, workflowType } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType, [defaultDataConverter.toPayloadSync('10s')]));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs('10s') })]));
  }
  {
    const req = await activate(t, makeFireTimer(1));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['slept']]);
});

test('setTimeoutAfterMicroTasks', async (t) => {
  const { logs, workflowType } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(100) })]));
  }
  {
    const req = await activate(t, makeFireTimer(1));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['slept']]);
});

test('promiseThenPromise', async (t) => {
  const { logs, workflowType } = t.context;
  const req = await activate(t, makeStartWorkflow(workflowType));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[2]]);
});

test('rejectPromise', async (t) => {
  const { logs, workflowType } = t.context;
  const req = await activate(t, makeStartWorkflow(workflowType));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[true], [true]]);
});

test('promiseAll', async (t) => {
  const { logs, workflowType } = t.context;
  const req = await activate(t, makeStartWorkflow(workflowType));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[1, 2, 3], [1, 2, 3], [1, 2, 3], ['wow']]);
});

test('tasksAndMicrotasks', async (t) => {
  const { logs, workflowType } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(1) })]));
  }
  {
    const req = await activate(t, makeFireTimer(1));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['script start'], ['script end'], ['promise1'], ['promise2'], ['setTimeout']]);
});

test('trailingTimer', async (t) => {
  const { logs, workflowType } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(1) }),
        makeStartTimerCommand({ seq: 2, startToFireTimeout: msToTs(1) }),
      ])
    );
  }
  {
    const completion = await activate(t, makeActivation(undefined, makeFireTimerJob(1), makeFireTimerJob(2)));
    // Note that the trailing timer does not get scheduled since the workflow completes
    // after the first timer is triggered causing the second one to be dropped.
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeStartTimerCommand({ seq: 3, startToFireTimeout: msToTs(1) }),
        makeCompleteWorkflowExecution(await defaultDataConverter.toPayload('first')),
      ])
    );
  }
  t.deepEqual(logs, []);
});

test('promiseRace', async (t) => {
  const { logs, workflowType } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(20) }),
        makeStartTimerCommand({ seq: 2, startToFireTimeout: msToTs(30) }),
      ])
    );
  }
  {
    const req = await activate(t, makeActivation(undefined, makeFireTimerJob(1), makeFireTimerJob(2)));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [[1], [1], [1], [1], [20], ['wow']]);
});

test('race', async (t) => {
  const { logs, workflowType } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(10) }),
        makeStartTimerCommand({ seq: 2, startToFireTimeout: msToTs(11) }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer(1));
    compareCompletion(t, req, makeSuccess([]));
  }
  {
    const req = await activate(t, makeFireTimer(2));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [[1], [2], [3]]);
});

test('importer', async (t) => {
  const { logs, workflowType } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(10) })]));
  }
  {
    const req = await activate(t, makeFireTimer(1));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['slept']]);
});

test('externalImporter', async (t) => {
  const { logs, workflowType } = t.context;
  const req = await activate(t, makeStartWorkflow(workflowType));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[{ a: 1, b: 2 }]]);
});

test('argsAndReturn', async (t) => {
  const { workflowType } = t.context;
  const req = await activate(
    t,
    makeStartWorkflow(workflowType, [
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

test('invalidOrFailedQueries', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(workflowType));
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
            source: 'TypeScriptSDK',
            stackTrace: dedent`
              DeterminismViolationError: Query handlers should not return a Promise
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
  {
    const completion = cleanWorkflowQueryFailureStackTrace(await activate(t, await makeQueryWorkflow('3', 'fail', [])));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeRespondToQueryCommand({
          queryId: '3',
          failed: {
            source: 'TypeScriptSDK',
            message: 'fail',
            stackTrace: dedent`
              Error: fail
                  at eval
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

test('interruptableWorkflow', async (t) => {
  const { workflowType } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType));
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
          ApplicationFailure: just because
              at Function.retryable
              at eval
          `,
          'Error',
          false
        ),
      ])
    );
  }
});

test('failSignalWorkflow', async (t) => {
  const { workflowType } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(100000) })]));
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
          ApplicationFailure: Signal failed
              at Function.nonRetryable
              at eval
          `,
          'Error'
        ),
      ])
    );
  }
});

test('asyncFailSignalWorkflow', async (t) => {
  const { workflowType } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(100000) })]));
  }
  {
    const req = await activate(t, await makeSignalWorkflow('fail', []));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ seq: 2, startToFireTimeout: msToTs(100) })]));
  }
  {
    const req = cleanWorkflowFailureStackTrace(await activate(t, makeFireTimer(2)));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeFailWorkflowExecution(
          'Signal failed',
          dedent`
          ApplicationFailure: Signal failed
              at Function.nonRetryable
              at eval
              at runNextTicks
              at listOnTimeout
              at processTimers`,
          'Error'
        ),
      ])
    );
  }
});

test('cancelWorkflow', async (t) => {
  const url = 'https://temporal.io';
  const { workflowType } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType, await defaultDataConverter.toPayloads(url)));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'httpGet',
          arguments: await defaultDataConverter.toPayloads(url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const req = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(t, req, makeSuccess([makeCancelActivityCommand(1)]));
  }
  {
    const req = await activate(
      t,
      makeActivation(undefined, {
        resolveActivity: {
          seq: 1,
          result: {
            cancelled: {
              failure: makeActivityCancelledFailure('1', 'httpGet'),
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
          seq: 3,
          activityId: '3',
          activityType: 'httpGet',
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
          seq: 3,
          result: { completed: { result } },
        },
      })
    );
    compareCompletion(t, req, makeSuccess([makeCompleteWorkflowExecution(result)]));
  }
});

test('cancel - unblockOrCancel', async (t) => {
  const { workflowType, logs } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(t, completion, makeSuccess([]));
  }
  {
    const completion = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(t, completion, makeSuccess());
  }
  t.deepEqual(logs, [['Blocked'], ['Cancelled']]);
});

test('unblock - unblockOrCancel', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(workflowType));
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
});

test('cancelTimer', async (t) => {
  const { workflowType, logs } = t.context;
  const req = await activate(t, makeStartWorkflow(workflowType));
  compareCompletion(
    t,
    req,
    makeSuccess([
      makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(1) }),
      makeCancelTimerCommand({ seq: 1 }),
      makeCompleteWorkflowExecution(),
    ])
  );
  t.deepEqual(logs, [['Timer cancelled 👍']]);
});

test('cancelTimerAltImpl', async (t) => {
  const { workflowType, logs } = t.context;
  const req = await activate(t, makeStartWorkflow(workflowType));
  compareCompletion(
    t,
    req,
    makeSuccess([
      makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(1) }),
      makeCancelTimerCommand({ seq: 1 }),
      makeCompleteWorkflowExecution(),
    ])
  );
  t.deepEqual(logs, [['Timer cancelled 👍']]);
});

test('nonCancellable', async (t) => {
  const { workflowType } = t.context;
  const url = 'https://temporal.io';
  const result = await defaultDataConverter.toPayload({ test: true });
  {
    const completion = await activate(t, makeStartWorkflow(workflowType, [await defaultDataConverter.toPayload(url)]));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'httpGetJSON',
          arguments: await defaultDataConverter.toPayloads(url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const completion = await activate(t, makeResolveActivity(1, { completed: { result } }));
    compareCompletion(t, completion, makeSuccess([makeCompleteWorkflowExecution(result)]));
  }
});

test('resumeAfterCancellation', async (t) => {
  const { workflowType } = t.context;
  const url = 'https://temporal.io';
  const result = await defaultDataConverter.toPayload({ test: true });
  {
    const completion = await activate(t, makeStartWorkflow(workflowType, [await defaultDataConverter.toPayload(url)]));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'httpGetJSON',
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
    const completion = await activate(t, makeResolveActivity(1, { completed: { result } }));
    compareCompletion(t, completion, makeSuccess([makeCompleteWorkflowExecution(result)]));
  }
});

test('handleExternalWorkflowCancellationWhileActivityRunning', async (t) => {
  const { workflowType } = t.context;
  const url = 'https://temporal.io';
  const data = { content: 'new HTML content' };
  {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const completion = await activate(
      t,
      makeStartWorkflow(workflowType, (await defaultDataConverter.toPayloads(url, data)) ?? [])
    );

    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'httpPostJSON',
          arguments: await defaultDataConverter.toPayloads(url, data),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const completion = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(t, completion, makeSuccess([makeCancelActivityCommand(1)]));
  }
  {
    const completion = await activate(
      t,
      makeResolveActivity(1, { cancelled: { failure: { canceledFailureInfo: {} } } })
    );
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          seq: 2,
          activityId: '2',
          activityType: 'cleanup',
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
      makeResolveActivity(2, { completed: { result: await defaultDataConverter.toPayload(undefined) } })
    );
    compareCompletion(t, completion, makeSuccess([{ cancelWorkflowExecution: {} }]));
  }
});

test('nestedCancellation', async (t) => {
  const { workflowType } = t.context;
  const url = 'https://temporal.io';
  {
    const completion = await activate(t, makeStartWorkflow(workflowType, [await defaultDataConverter.toPayload(url)]));

    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'setup',
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const completion = await activate(
      t,
      makeResolveActivity(1, { completed: { result: await defaultDataConverter.toPayload(undefined) } })
    );

    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(1000) }),
        makeScheduleActivityCommand({
          seq: 2,
          activityId: '2',
          activityType: 'httpPostJSON',
          arguments: await defaultDataConverter.toPayloads(url, { some: 'data' }),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  {
    const completion = await activate(t, makeFireTimer(1));
    compareCompletion(t, completion, makeSuccess([makeCancelActivityCommand(2)]));
  }
  const failure = makeActivityCancelledFailure('2', 'httpPostJSON');
  {
    const completion = await activate(t, makeResolveActivity(2, { cancelled: { failure } }));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '3',
          seq: 3,
          activityType: 'cleanup',
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
      makeResolveActivity(3, { completed: { result: await defaultDataConverter.toPayload(undefined) } })
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

test('sharedScopes', async (t) => {
  const { workflowType } = t.context;
  const result = { some: 'data' };
  {
    const completion = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(
      t,
      completion,
      makeSuccess(
        await Promise.all(
          [1, 2].map(async (idx) =>
            makeScheduleActivityCommand({
              seq: idx,
              activityId: `${idx}`,
              activityType: 'httpGetJSON',
              arguments: await defaultDataConverter.toPayloads(`http://url${idx}.ninja`),
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
      makeResolveActivity(2, { completed: { result: await defaultDataConverter.toPayload(result) } })
    );
    compareCompletion(
      t,
      completion,
      makeSuccess([makeCompleteWorkflowExecution(await defaultDataConverter.toPayload(result))])
    );
  }
});

test('shieldAwaitedInRootScope', async (t) => {
  const { workflowType } = t.context;
  const result = { some: 'data' };
  {
    const completion = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'httpGetJSON',
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
      makeResolveActivity(1, { completed: { result: await defaultDataConverter.toPayload(result) } })
    );
    compareCompletion(
      t,
      completion,
      makeSuccess([makeCompleteWorkflowExecution(await defaultDataConverter.toPayload(result))])
    );
  }
});

test('cancellationScopesWithCallbacks', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(t, completion, makeSuccess([makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(10) })]));
  }
  {
    const completion = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(t, completion, makeSuccess([{ cancelWorkflowExecution: {} }]));
  }
});

test('cancellationScopes', async (t) => {
  const { workflowType, logs } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(3) })]));
  }
  {
    const req = await activate(t, makeFireTimer(1));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ seq: 2, startToFireTimeout: msToTs(3) }),
        makeStartTimerCommand({ seq: 3, startToFireTimeout: msToTs(3) }),
        makeCancelTimerCommand({ seq: 2 }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer(3));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ seq: 4, startToFireTimeout: msToTs(3) })]));
  }
  {
    const req = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(t, req, makeSuccess([makeCancelTimerCommand({ seq: 4 }), makeCompleteWorkflowExecution()]));
  }
  t.deepEqual(logs, [
    ['Scope cancelled 👍'],
    ['Exception was propagated 👍'],
    ['Scope 2 was not cancelled 👍'],
    ['Scope cancelled 👍'],
    ['Exception was propagated 👍'],
  ]);
});

test('childAndShield', async (t) => {
  const { workflowType } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(5) })]));
  }
  {
    const req = await activate(t, makeFireTimer(1));
    compareCompletion(t, req, makeSuccess());
  }
});

test('partialShield', async (t) => {
  const { workflowType, logs } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(5) }),
        makeStartTimerCommand({ seq: 2, startToFireTimeout: msToTs(3) }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer(2));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ seq: 3, startToFireTimeout: msToTs(2) })]));
  }
  {
    const req = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeCancelTimerCommand({ seq: 3 }),
        makeStartTimerCommand({ seq: 4, startToFireTimeout: msToTs(10) }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer(1));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ seq: 5, startToFireTimeout: msToTs(1) })]));
  }
  {
    const req = await activate(t, makeFireTimer(4));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['Workflow cancelled']]);
});

test('shieldInShield', async (t) => {
  const { workflowType, logs } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(2) }),
        makeStartTimerCommand({ seq: 2, startToFireTimeout: msToTs(1) }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer(2));
    compareCompletion(t, req, makeSuccess([]));
  }
  {
    const req = await activate(t, makeFireTimer(1));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['Timer 1 finished 👍'], ['Timer 0 finished 👍']]);
});

test('cancellationErrorIsPropagated', async (t) => {
  const { workflowType, logs } = t.context;
  const req = cleanWorkflowFailureStackTrace(await activate(t, makeStartWorkflow(workflowType)), 2);
  compareCompletion(
    t,
    req,
    makeSuccess([
      makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(1) }),
      makeCancelTimerCommand({ seq: 1 }),
      {
        failWorkflowExecution: {
          failure: {
            message: 'Cancellation scope cancelled',
            stackTrace: dedent`
        CancelledFailure: Cancellation scope cancelled
            at CancellationScope.cancel
            at eval
            at CancellationScope.runInContext
            at AsyncLocalStorage.run
            at CancellationScope.run
            at Function.cancellable
            at cancellationErrorIsPropagated
        `,
            canceledFailureInfo: {},
            source: 'TypeScriptSDK',
          },
        },
      },
    ])
  );
  t.deepEqual(logs, []);
});

test('cancelActivityAfterFirstCompletion', async (t) => {
  const url = 'https://temporal.io';
  const { workflowType, logs } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType, await defaultDataConverter.toPayloads(url)));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'httpGet',
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
      makeResolveActivity(1, { completed: { result: await defaultDataConverter.toPayload('response1') } })
    );
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          seq: 2,
          activityId: '2',
          activityType: 'httpGet',
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
      makeResolveActivity(2, { completed: { result: await defaultDataConverter.toPayload('response2') } })
    );
    compareCompletion(
      t,
      req,
      makeSuccess([makeCompleteWorkflowExecution(await defaultDataConverter.toPayload(['response1', 'response2']))])
    );
  }
  t.deepEqual(logs, [['Workflow cancelled while waiting on non cancellable scope']]);
});

test('multipleActivitiesSingleTimeout', async (t) => {
  const urls = ['https://slow-site.com/', 'https://slow-site.org/'];
  const { workflowType } = t.context;
  {
    const completion = await activate(
      t,
      makeStartWorkflow(workflowType, await defaultDataConverter.toPayloads(urls, 1000))
    );
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(1000) }),
        ...(await Promise.all(
          urls.map(async (url, index) =>
            makeScheduleActivityCommand({
              seq: index + 1,
              activityId: `${index + 1}`,
              activityType: 'httpGetJSON',
              arguments: await defaultDataConverter.toPayloads(url),
              startToCloseTimeout: msToTs('1s'),
              taskQueue: 'test',
            })
          )
        )),
      ])
    );
  }
  {
    const completion = await activate(t, makeFireTimer(1));
    compareCompletion(t, completion, makeSuccess([makeCancelActivityCommand(1), makeCancelActivityCommand(2)]));
  }
  const failure1 = makeActivityCancelledFailure('1', 'httpGetJSON');
  const failure2 = makeActivityCancelledFailure('2', 'httpGetJSON');
  {
    const completion = await activate(
      t,
      makeActivation(
        undefined,
        { resolveActivity: { seq: 1, result: { cancelled: { failure: failure1 } } } },
        { resolveActivity: { seq: 2, result: { cancelled: { failure: failure2 } } } }
      )
    );
    compareCompletion(t, completion, makeSuccess([{ failWorkflowExecution: { failure: failure1 } }]));
  }
});

test('resolve activity with result - http', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'httpGet',
          arguments: await defaultDataConverter.toPayloads('https://temporal.io'),
          startToCloseTimeout: msToTs('1 minute'),
          taskQueue: 'test',
        }),
      ])
    );
  }
  const result = '<html><body>hello from https://temporal.io</body></html>';
  {
    const completion = await activate(
      t,
      makeResolveActivity(1, { completed: { result: await defaultDataConverter.toPayload(result) } })
    );

    compareCompletion(
      t,
      completion,
      makeSuccess([makeCompleteWorkflowExecution(defaultDataConverter.toPayloadSync(result))])
    );
  }
});

test('resolve activity with failure - http', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'httpGet',
          arguments: await defaultDataConverter.toPayloads('https://temporal.io'),
          startToCloseTimeout: msToTs('1 minute'),
          taskQueue: 'test',
        }),
      ])
    );
  }

  const failure = ApplicationFailure.nonRetryable('Connection timeout', 'MockError');
  failure.stack = failure.stack?.split('\n')[0];

  {
    const completion = await activate(
      t,
      makeResolveActivity(1, {
        failed: {
          failure: await errorToFailure(failure, defaultDataConverter),
        },
      })
    );
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeFailWorkflowExecution('Connection timeout', 'ApplicationFailure: Connection timeout', 'MockError'),
      ])
    );
  }
});

test('globalOverrides', async (t) => {
  const { workflowType, logs } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(t, completion, makeSuccess());
  }
  t.deepEqual(
    logs,
    ['WeakRef' /* First error happens on startup */, 'FinalizationRegistry', 'WeakRef'].map((type) => [
      `DeterminismViolationError: ${type} cannot be used in workflows because v8 GC is non-deterministic`,
    ])
  );
});

test('logAndTimeout', async (t) => {
  const { workflowType, workflow } = t.context;
  await t.throwsAsync(activate(t, makeStartWorkflow(workflowType)), {
    code: 'ERR_SCRIPT_EXECUTION_TIMEOUT',
    message: 'Script execution timed out after 100ms',
  });
  const calls = await workflow.getAndResetSinkCalls();
  t.deepEqual(calls, [{ ifaceName: 'logger', fnName: 'info', args: ['logging before getting stuck'] }]);
});

test('continueAsNewSameWorkflow', async (t) => {
  const { workflowType } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(
      t,
      req,
      makeSuccess([
        {
          continueAsNewWorkflowExecution: {
            workflowType,
            taskQueue: 'test',
            arguments: await defaultDataConverter.toPayloads('signal'),
          },
        },
      ])
    );
  }
});

test('not-replay patchedWorkflow', async (t) => {
  const { logs, workflowType } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeSetPatchMarker('my-change-id', false),
        makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(100) }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer(1));
    compareCompletion(t, req, makeSuccess([makeCompleteWorkflowExecution()]));
  }
  t.deepEqual(logs, [['has change'], ['has change 2']]);
});

test('replay-no-marker patchedWorkflow', async (t) => {
  const { logs, workflowType } = t.context;
  {
    const act: coresdk.workflow_activation.IWorkflowActivation = {
      runId: 'test-runId',
      timestamp: msToTs(Date.now()),
      isReplaying: true,
      jobs: [makeStartWorkflowJob(workflowType)],
    };
    const completion = await activate(t, act);
    compareCompletion(t, completion, makeSuccess([makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(100) })]));
  }
  {
    const act: coresdk.workflow_activation.IWorkflowActivation = {
      runId: 'test-runId',
      timestamp: msToTs(Date.now()),
      isReplaying: true,
      jobs: [makeFireTimerJob(1)],
    };
    const completion = await activate(t, act);
    compareCompletion(t, completion, makeSuccess([makeCompleteWorkflowExecution()]));
  }
  t.deepEqual(logs, [['no change'], ['no change 2']]);
});

test('replay-no-marker-then-not-replay patchedWorkflow', async (t) => {
  const { logs, workflowType } = t.context;
  {
    const act: coresdk.workflow_activation.IWorkflowActivation = {
      runId: 'test-runId',
      timestamp: msToTs(Date.now()),
      isReplaying: true,
      jobs: [makeStartWorkflowJob(workflowType)],
    };
    const completion = await activate(t, act);
    compareCompletion(t, completion, makeSuccess([makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(100) })]));
  }
  // For this second activation we are no longer replaying, let core know we have the marker
  {
    const completion = await activate(t, makeFireTimer(1));
    compareCompletion(
      t,
      completion,
      makeSuccess([makeSetPatchMarker('my-change-id', false), makeCompleteWorkflowExecution()])
    );
  }
  t.deepEqual(logs, [['no change'], ['has change 2']]);
});

test('replay-with-marker patchedWorkflow', async (t) => {
  const { logs, workflowType } = t.context;
  {
    const act: coresdk.workflow_activation.IWorkflowActivation = {
      runId: 'test-runId',
      timestamp: msToTs(Date.now()),
      isReplaying: true,
      jobs: [makeStartWorkflowJob(workflowType), makeNotifyHasPatchJob('my-change-id')],
    };
    const completion = await activate(t, act);
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeSetPatchMarker('my-change-id', false),
        makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(100) }),
      ])
    );
  }
  {
    const completion = await activate(t, makeFireTimer(1));
    compareCompletion(t, completion, makeSuccess([makeCompleteWorkflowExecution()]));
  }
  t.deepEqual(logs, [['has change'], ['has change 2']]);
});

test('deprecatePatchWorkflow', async (t) => {
  const { logs, workflowType } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(
      t,
      completion,
      makeSuccess([makeSetPatchMarker('my-change-id', true), makeCompleteWorkflowExecution()])
    );
  }
  t.deepEqual(logs, [['has change']]);
});

test('patchedTopLevel', async (t) => {
  const { workflowType, logs } = t.context;
  const completion = await activate(t, makeStartWorkflow(workflowType));
  compareCompletion(t, completion, makeSuccess());
  t.deepEqual(logs, [[['Patches cannot be used before Workflow starts']]]);
});

test('tryToContinueAfterCompletion', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = cleanWorkflowFailureStackTrace(await activate(t, makeStartWorkflow(workflowType)));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeFailWorkflowExecution(
          'fail before continue',
          dedent`
          ApplicationFailure: fail before continue
              at Function.nonRetryable
              at tryToContinueAfterCompletion
        `
        ),
      ])
    );
  }
});

test('failUnlessSignaledBeforeStart', async (t) => {
  const { workflowType } = t.context;
  const completion = await activate(
    t,
    makeActivation(undefined, makeStartWorkflowJob(workflowType), {
      signalWorkflow: { signalName: 'someShallPass' },
    })
  );
  compareCompletion(t, completion, makeSuccess());
});

test('conditionWaiter', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(t, completion, makeSuccess([makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(1) })]));
  }
  {
    const completion = await activate(t, makeFireTimer(1));
    compareCompletion(
      t,
      completion,
      makeSuccess([makeStartTimerCommand({ seq: 2, startToFireTimeout: msToTs('1s') })])
    );
  }
  {
    const completion = await activate(t, makeFireTimer(2));
    compareCompletion(t, completion, makeSuccess([makeCompleteWorkflowExecution()]));
  }
});
