import path from 'node:path';
import vm from 'node:vm';
import anyTest, { ExecutionContext, TestFn } from 'ava';
import dedent from 'dedent';
import Long from 'long';
import {
  ApplicationFailure,
  defaultFailureConverter,
  defaultPayloadConverter,
  SdkComponent,
  Payload,
  toPayloads,
  TypedSearchAttributes,
} from '@temporalio/common';
import { msToTs } from '@temporalio/common/lib/time';
import { coresdk, temporal } from '@temporalio/proto';
import { LogTimestamp } from '@temporalio/worker';
import { WorkflowCodeBundler } from '@temporalio/worker/lib/workflow/bundler';
import { VMWorkflow, VMWorkflowCreator } from '@temporalio/worker/lib/workflow/vm';
import { SdkFlag, SdkFlags } from '@temporalio/workflow/lib/flags';
import { ReusableVMWorkflow, ReusableVMWorkflowCreator } from '@temporalio/worker/lib/workflow/reusable-vm';
import { parseWorkflowCode } from '@temporalio/worker/lib/worker';
import * as activityFunctions from './activities';
import { cleanStackTrace, compareStackTrace, REUSE_V8_CONTEXT, u8 } from './helpers';
import { ProcessedSignal } from './workflows';

export interface Context {
  workflow: VMWorkflow | ReusableVMWorkflow;
  logs: unknown[][];
  workflowType: string;
  startTime: number;
  runId: string;
  workflowCreator: TestVMWorkflowCreator | TestReusableVMWorkflowCreator;
}

const test = anyTest as TestFn<Context>;

function injectCustomConsole(logsGetter: (runId: string) => unknown[][], context: vm.Context) {
  context.console = {
    log(...args: unknown[]) {
      const { runId } = context.__TEMPORAL_ACTIVATOR__.info;
      logsGetter(runId).push(args);
    },
  };
}

class TestVMWorkflowCreator extends VMWorkflowCreator {
  public logs: Record<string, unknown[][]> = {};

  override injectGlobals(context: vm.Context) {
    super.injectGlobals(context);
    injectCustomConsole((runId) => this.logs[runId], context);
  }
}

class TestReusableVMWorkflowCreator extends ReusableVMWorkflowCreator {
  public logs: Record<string, unknown[][]> = {};

  override injectGlobals(context: vm.Context) {
    super.injectGlobals(context);
    injectCustomConsole((runId) => this.logs[runId], context);
  }
}

test.before(async (t) => {
  const workflowsPath = path.join(__dirname, 'workflows');
  const bundler = new WorkflowCodeBundler({ workflowsPath });
  const workflowBundle = parseWorkflowCode((await bundler.createBundle()).code);
  // FIXME: isolateExecutionTimeoutMs used to be 200 ms, but that's causing
  //        lot of flakes on CI. Revert this after investigation / resolution.
  t.context.workflowCreator = REUSE_V8_CONTEXT
    ? await TestReusableVMWorkflowCreator.create(workflowBundle, 400, new Set())
    : await TestVMWorkflowCreator.create(workflowBundle, 400, new Set());
});

test.after.always(async (t) => {
  await t.context.workflowCreator.destroy();
});

test.beforeEach(async (t) => {
  const { workflowCreator } = t.context;

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

test.afterEach(async (t) => {
  await t.context.workflow?.dispose();
});

async function createWorkflow(
  workflowType: string,
  runId: string,
  startTime: number,
  workflowCreator: VMWorkflowCreator | ReusableVMWorkflowCreator
) {
  const workflow = (await workflowCreator.createWorkflow({
    info: {
      workflowType,
      runId,
      workflowId: 'test-workflowId',
      namespace: 'default',
      firstExecutionRunId: runId,
      attempt: 1,
      taskTimeoutMs: 1000,
      taskQueue: 'test',
      searchAttributes: {},
      typedSearchAttributes: new TypedSearchAttributes(),
      historyLength: 3,
      historySize: 300,
      continueAsNewSuggested: false,
      unsafe: { isReplaying: false, now: Date.now },
      startTime: new Date(),
      runStartTime: new Date(),
    },
    randomnessSeed: Long.fromInt(1337).toBytes(),
    now: startTime,
    showStackTraceSources: true,
  })) as VMWorkflow;
  return workflow;
}

async function activate(t: ExecutionContext<Context>, activation: coresdk.workflow_activation.IWorkflowActivation) {
  const { workflow, runId } = t.context;

  // Core guarantees the following jobs ordering:
  //   initWf -> patches -> update random seed -> signals+update -> others -> Resolve LA
  // reference: github.com/temporalio/sdk-core/blob/a8150d5c7c3fc1bfd5a941fd315abff1556cd9dc/core/src/worker/workflow/mod.rs#L1363-L1378
  // Tests are likely to fail if we artifically make an activation that does not follow that order
  const jobs: coresdk.workflow_activation.IWorkflowActivationJob[] = activation.jobs ?? [];
  function getPriority(job: coresdk.workflow_activation.IWorkflowActivationJob) {
    if (job.initializeWorkflow) return 0;
    if (job.notifyHasPatch) return 1;
    if (job.updateRandomSeed) return 2;
    if (job.signalWorkflow || job.doUpdate) return 3;
    if (job.resolveActivity && job.resolveActivity.isLocal) return 5;
    return 4;
  }
  jobs.reduce((prevPriority: number, currJob) => {
    const currPriority = getPriority(currJob);
    if (prevPriority > currPriority) {
      throw new Error('Jobs are not correctly sorted');
    }
    return currPriority;
  }, 0);

  const completion = await workflow.activate(coresdk.workflow_activation.WorkflowActivation.fromObject(activation));
  t.deepEqual(completion.runId, runId);
  return completion;
}

function compareCompletion(
  t: ExecutionContext<Context>,
  req: coresdk.workflow_completion.IWorkflowActivationCompletion,
  expected: coresdk.workflow_completion.IWorkflowActivationCompletion
) {
  const stackTraces = extractFailureStackTraces(req, expected);
  t.deepEqual(
    coresdk.workflow_completion.WorkflowActivationCompletion.create(req).toJSON(),
    coresdk.workflow_completion.WorkflowActivationCompletion.create({
      ...expected,
      runId: t.context.runId,
    }).toJSON()
  );

  if (stackTraces) {
    for (const { actual, expected } of stackTraces) {
      compareStackTrace(t, actual, expected);
    }
  }
}

// Extracts failure stack traces from completions if structure matches, leaving them unchanged if structure differs.
// We leave them unchanged on structure differences as ava's `deepEqual` provides a better failure message.
function extractFailureStackTraces(
  req: coresdk.workflow_completion.IWorkflowActivationCompletion,
  expected: coresdk.workflow_completion.IWorkflowActivationCompletion
): { actual: string; expected: string }[] | undefined {
  const reqCommands = req.successful?.commands;
  const expectedCommands = expected.successful?.commands;
  if (!reqCommands || !expectedCommands || reqCommands.length !== expectedCommands.length) {
    return;
  }
  for (let commandIndex = 0; commandIndex < reqCommands.length; commandIndex++) {
    const reqStack = reqCommands[commandIndex].failWorkflowExecution?.failure?.stackTrace;
    const expectedStack = expectedCommands[commandIndex].failWorkflowExecution?.failure?.stackTrace;
    if (typeof reqStack !== typeof expectedStack) {
      return;
    }
  }
  const stackTraces: { actual: string; expected: string }[] = [];
  for (let commandIndex = 0; commandIndex < reqCommands.length; commandIndex++) {
    const reqStack = reqCommands[commandIndex].failWorkflowExecution?.failure?.stackTrace;
    const expectedStack = expectedCommands[commandIndex].failWorkflowExecution?.failure?.stackTrace;
    if (reqStack && expectedStack) {
      stackTraces.push({ actual: reqStack, expected: expectedStack });
      delete reqCommands[commandIndex].failWorkflowExecution?.failure?.stackTrace;
      delete expectedCommands[commandIndex].failWorkflowExecution?.failure?.stackTrace;
    }
  }
  return stackTraces;
}

function makeSuccess(
  commands: coresdk.workflow_commands.IWorkflowCommand[] = [makeCompleteWorkflowExecution()],
  usedInternalFlags: SdkFlag[] = []
): coresdk.workflow_completion.IWorkflowActivationCompletion {
  return {
    successful: {
      commands,
      usedInternalFlags: usedInternalFlags.map((x) => x.id),
    },
  };
}

function makeStartWorkflow(
  workflowType: string,
  args?: Payload[],
  timestamp: number = Date.now()
): coresdk.workflow_activation.IWorkflowActivation {
  return makeActivation(timestamp, makeInitializeWorkflowJob(workflowType, args));
}

function makeInitializeWorkflowJob(
  workflowType: string,
  args?: Payload[]
): { initializeWorkflow: coresdk.workflow_activation.IInitializeWorkflow } {
  return {
    initializeWorkflow: { workflowId: 'test-workflowId', workflowType, arguments: args },
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
      retryState: temporal.api.enums.v1.RetryState.RETRY_STATE_CANCEL_REQUESTED,
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

function makeQueryWorkflow(
  queryId: string,
  queryType: string,
  queryArgs: any[],
  timestamp: number = Date.now()
): coresdk.workflow_activation.IWorkflowActivation {
  return makeActivation(timestamp, makeQueryWorkflowJob(queryId, queryType, ...queryArgs));
}

function makeQueryWorkflowJob(
  queryId: string,
  queryType: string,
  ...queryArgs: any[]
): coresdk.workflow_activation.IWorkflowActivationJob {
  return {
    queryWorkflow: {
      queryId,
      queryType,
      arguments: toPayloads(defaultPayloadConverter, ...queryArgs),
    },
  };
}

async function makeSignalWorkflow(
  signalName: string,
  args: any[],
  timestamp: number = Date.now()
): Promise<coresdk.workflow_activation.IWorkflowActivation> {
  return makeActivation(timestamp, makeSignalWorkflowJob(signalName, args));
}

function makeSignalWorkflowJob(signalName: string, args: any[]): coresdk.workflow_activation.IWorkflowActivationJob {
  return {
    signalWorkflow: { signalName, input: toPayloads(defaultPayloadConverter, ...args) },
  };
}

function makeCompleteWorkflowExecution(result?: Payload): coresdk.workflow_commands.IWorkflowCommand {
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

function makeUpdateActivationJob(
  id: string,
  protocolInstanceId: string,
  name: string,
  input: unknown[]
): coresdk.workflow_activation.IWorkflowActivationJob {
  return {
    doUpdate: {
      id,
      protocolInstanceId,
      name,
      input: toPayloads(defaultPayloadConverter, ...input),
    },
  };
}

function makeUpdateAcceptedResponse(id: string): coresdk.workflow_commands.IWorkflowCommand {
  return {
    updateResponse: {
      protocolInstanceId: id,
      accepted: {},
    },
  };
}

function makeUpdateCompleteResponse(id: string, result: unknown): coresdk.workflow_commands.IWorkflowCommand {
  return {
    updateResponse: {
      protocolInstanceId: id,
      completed: defaultPayloadConverter.toPayload(result),
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
  compareCompletion(t, req, makeSuccess([makeCompleteWorkflowExecution(defaultPayloadConverter.toPayload('success'))]));
});

test('continueAsNewSuggested', async (t) => {
  const { workflowType } = t.context;
  const activation = makeStartWorkflow(workflowType);
  activation.continueAsNewSuggested = true;
  const req = await activate(t, activation);
  compareCompletion(t, req, makeSuccess([makeCompleteWorkflowExecution(defaultPayloadConverter.toPayload(true))]));
});

function cleanWorkflowFailureStackTrace(
  req: coresdk.workflow_completion.IWorkflowActivationCompletion,
  commandIndex = 0
) {
  req.successful!.commands![commandIndex].failWorkflowExecution!.failure!.stackTrace = cleanStackTrace(
    req.successful!.commands![commandIndex].failWorkflowExecution!.failure!.stackTrace!
  );
  return req;
}

function cleanWorkflowQueryFailureStackTrace(
  req: coresdk.workflow_completion.IWorkflowActivationCompletion,
  commandIndex = 0
) {
  req.successful!.commands![commandIndex].respondToQuery!.failed!.stackTrace = cleanStackTrace(
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
            at $CLASS.nonRetryable (common/src/failure.ts)
            at throwAsync (test/src/workflows/throw-async.ts)
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
  compareCompletion(t, req, makeSuccess([makeCompleteWorkflowExecution(defaultPayloadConverter.toPayload('async'))]));
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
    const req = await activate(t, makeStartWorkflow(workflowType, [defaultPayloadConverter.toPayload('10s')]));
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
    compareCompletion(
      t,
      req,
      makeSuccess(
        [makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(1) })],
        [SdkFlags.NonCancellableScopesAreShieldedFromPropagation]
      )
    );
  }
  {
    const req = await activate(t, makeFireTimer(1));
    compareCompletion(
      t,
      req,
      makeSuccess([makeCompleteWorkflowExecution()], [SdkFlags.NonCancellableScopesAreShieldedFromPropagation])
    );
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
        makeCompleteWorkflowExecution(defaultPayloadConverter.toPayload('first')),
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
    compareCompletion(
      t,
      req,
      makeSuccess(
        [makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(10) })],
        [SdkFlags.NonCancellableScopesAreShieldedFromPropagation]
      )
    );
  }
  {
    const req = await activate(t, makeFireTimer(1));
    compareCompletion(
      t,
      req,
      makeSuccess([makeCompleteWorkflowExecution()], [SdkFlags.NonCancellableScopesAreShieldedFromPropagation])
    );
  }
  t.deepEqual(logs, [['slept']]);
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
      await activate(t, makeQueryWorkflow('3', 'invalidAsyncMethod', []))
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
            stackTrace: 'DeterminismViolationError: Query handlers should not return a Promise',
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
    const completion = cleanWorkflowQueryFailureStackTrace(await activate(t, makeQueryWorkflow('3', 'fail', [])));
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
                  at test/src/workflows/invalid-or-failed-queries.ts
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
      makeSuccess(
        [
          makeFailWorkflowExecution(
            'just because',
            // The stack trace is weird here and might confuse users, it might be a JS limitation
            // since the Error stack trace is generated in the constructor.
            dedent`
          ApplicationFailure: just because
              at $CLASS.retryable (common/src/failure.ts)
              at test/src/workflows/interrupt-signal.ts
          `,
            'Error',
            false
          ),
        ],
        [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]
      )
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
      makeSuccess(
        [
          makeFailWorkflowExecution(
            'Signal failed',
            dedent`
          ApplicationFailure: Signal failed
              at $CLASS.nonRetryable (common/src/failure.ts)
              at test/src/workflows/fail-signal.ts
          `,
            'Error'
          ),
        ],
        [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]
      )
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
    compareCompletion(
      t,
      req,
      makeSuccess(
        [makeStartTimerCommand({ seq: 2, startToFireTimeout: msToTs(100) })],
        [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]
      )
    );
  }
  {
    const req = cleanWorkflowFailureStackTrace(await activate(t, makeFireTimer(2)));
    compareCompletion(
      t,
      req,
      makeSuccess(
        [
          makeFailWorkflowExecution(
            'Signal failed',
            dedent`
          ApplicationFailure: Signal failed
              at $CLASS.nonRetryable (common/src/failure.ts)
              at test/src/workflows/async-fail-signal.ts`,
            'Error'
          ),
        ],
        [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]
      )
    );
  }
});

test('cancelWorkflow', async (t) => {
  const url = 'https://temporal.io';
  const { workflowType } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(workflowType, toPayloads(defaultPayloadConverter, url)));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'httpGet',
          arguments: toPayloads(defaultPayloadConverter, url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
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
          arguments: toPayloads(defaultPayloadConverter, url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
        }),
      ])
    );
  }
  const result = defaultPayloadConverter.toPayload(await activityFunctions.httpGet(url));
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
    const completion = await activate(t, makeQueryWorkflow('1', 'isBlocked', []));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeRespondToQueryCommand({
          queryId: '1',
          succeeded: { response: defaultPayloadConverter.toPayload(true) },
        }),
      ])
    );
  }
  {
    const completion = await activate(t, await makeSignalWorkflow('unblock', []));
    compareCompletion(t, completion, makeSuccess(undefined, [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]));
  }
  {
    const completion = await activate(t, makeQueryWorkflow('2', 'isBlocked', []));
    compareCompletion(
      t,
      completion,
      makeSuccess(
        [
          makeRespondToQueryCommand({
            queryId: '2',
            succeeded: { response: defaultPayloadConverter.toPayload(false) },
          }),
        ],
        [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]
      )
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
  const result = defaultPayloadConverter.toPayload({ test: true });
  {
    const completion = await activate(t, makeStartWorkflow(workflowType, [defaultPayloadConverter.toPayload(url)]));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'httpGetJSON',
          arguments: toPayloads(defaultPayloadConverter, url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
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
  const result = defaultPayloadConverter.toPayload({ test: true });
  {
    const completion = await activate(t, makeStartWorkflow(workflowType, [defaultPayloadConverter.toPayload(url)]));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'httpGetJSON',
          arguments: toPayloads(defaultPayloadConverter, url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
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
    const completion = await activate(
      t,
      makeStartWorkflow(workflowType, toPayloads(defaultPayloadConverter, url, data) ?? [])
    );

    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'httpPostJSON',
          arguments: toPayloads(defaultPayloadConverter, url, data),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
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
          arguments: toPayloads(defaultPayloadConverter, url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
        }),
      ])
    );
  }
  {
    const completion = await activate(
      t,
      makeResolveActivity(2, { completed: { result: defaultPayloadConverter.toPayload(undefined) } })
    );
    compareCompletion(t, completion, makeSuccess([{ cancelWorkflowExecution: {} }]));
  }
});

test('nestedCancellation', async (t) => {
  const { workflowType } = t.context;
  const url = 'https://temporal.io';
  {
    const completion = await activate(t, makeStartWorkflow(workflowType, [defaultPayloadConverter.toPayload(url)]));

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
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
        }),
      ])
    );
  }
  {
    const completion = await activate(
      t,
      makeResolveActivity(1, { completed: { result: defaultPayloadConverter.toPayload(undefined) } })
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
          arguments: toPayloads(defaultPayloadConverter, url, { some: 'data' }),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
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
          arguments: toPayloads(defaultPayloadConverter, url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
        }),
      ])
    );
  }
  {
    const completion = await activate(
      t,
      makeResolveActivity(3, { completed: { result: defaultPayloadConverter.toPayload(undefined) } })
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

test('sharedCancellationScopes', async (t) => {
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
              arguments: toPayloads(defaultPayloadConverter, `http://url${idx}.ninja`),
              startToCloseTimeout: msToTs('10m'),
              taskQueue: 'test',
              doNotEagerlyExecute: false,
              versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
            })
          )
        )
      )
    );
  }
  {
    const completion = await activate(
      t,
      makeResolveActivity(2, { completed: { result: defaultPayloadConverter.toPayload(result) } })
    );
    compareCompletion(
      t,
      completion,
      makeSuccess([makeCompleteWorkflowExecution(defaultPayloadConverter.toPayload(result))])
    );
  }
});

test('nonCancellableAwaitedInRootScope', async (t) => {
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
          arguments: toPayloads(defaultPayloadConverter, `http://example.com`),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
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
      makeResolveActivity(1, { completed: { result: defaultPayloadConverter.toPayload(result) } })
    );
    compareCompletion(
      t,
      completion,
      makeSuccess([makeCompleteWorkflowExecution(defaultPayloadConverter.toPayload(result))])
    );
  }
});

test('cancellationScopesWithCallbacks', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(
      t,
      completion,
      makeSuccess(
        [makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(10) })],
        [SdkFlags.NonCancellableScopesAreShieldedFromPropagation]
      )
    );
  }
  {
    const completion = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(
      t,
      completion,
      makeSuccess(
        [{ cancelTimer: { seq: 1 } }, { cancelWorkflowExecution: {} }],
        [SdkFlags.NonCancellableScopesAreShieldedFromPropagation]
      )
    );
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

test('childAndNonCancellable', async (t) => {
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

test('partialNonCancellable', async (t) => {
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

test('nonCancellableInNonCancellable', async (t) => {
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
            at CancellationScope.cancel (workflow/src/cancellation-scope.ts)
            at test/src/workflows/cancellation-error-is-propagated.ts
            at CancellationScope.runInContext (workflow/src/cancellation-scope.ts)
            at CancellationScope.run (workflow/src/cancellation-scope.ts)
            at $CLASS.cancellable (workflow/src/cancellation-scope.ts)
            at cancellationErrorIsPropagated (test/src/workflows/cancellation-error-is-propagated.ts)
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
    const req = await activate(t, makeStartWorkflow(workflowType, toPayloads(defaultPayloadConverter, url)));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'httpGet',
          arguments: toPayloads(defaultPayloadConverter, url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
        }),
      ])
    );
  }
  {
    const req = await activate(
      t,
      makeResolveActivity(1, { completed: { result: defaultPayloadConverter.toPayload('response1') } })
    );
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          seq: 2,
          activityId: '2',
          activityType: 'httpGet',
          arguments: toPayloads(defaultPayloadConverter, url),
          startToCloseTimeout: msToTs('10m'),
          taskQueue: 'test',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
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
      makeResolveActivity(2, { completed: { result: defaultPayloadConverter.toPayload('response2') } })
    );
    compareCompletion(
      t,
      req,
      makeSuccess([makeCompleteWorkflowExecution(defaultPayloadConverter.toPayload(['response1', 'response2']))])
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
      makeStartWorkflow(workflowType, toPayloads(defaultPayloadConverter, urls, 1000))
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
              arguments: toPayloads(defaultPayloadConverter, url),
              startToCloseTimeout: msToTs('1s'),
              taskQueue: 'test',
              doNotEagerlyExecute: false,
              versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
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
          arguments: toPayloads(defaultPayloadConverter, 'https://temporal.io'),
          startToCloseTimeout: msToTs('1 minute'),
          taskQueue: 'test',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
        }),
      ])
    );
  }
  const result = '<html><body>hello from https://temporal.io</body></html>';
  {
    const completion = await activate(
      t,
      makeResolveActivity(1, { completed: { result: defaultPayloadConverter.toPayload(result) } })
    );

    compareCompletion(
      t,
      completion,
      makeSuccess([makeCompleteWorkflowExecution(defaultPayloadConverter.toPayload(result))])
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
          arguments: toPayloads(defaultPayloadConverter, 'https://temporal.io'),
          startToCloseTimeout: msToTs('1 minute'),
          taskQueue: 'test',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
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
          failure: defaultFailureConverter.errorToFailure(failure, defaultPayloadConverter),
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
      `DeterminismViolationError: ${type} cannot be used in Workflows because v8 GC is non-deterministic`,
    ])
  );
});

test('logAndTimeout', async (t) => {
  const { workflowType, workflow } = t.context;
  const completion = await activate(t, makeStartWorkflow(workflowType));
  compareCompletion(t, completion, {
    failed: {
      failure: {
        message: 'Script execution timed out after 400ms',
        source: 'TypeScriptSDK',
        stackTrace: 'Error: Script execution timed out after 400ms',
        cause: undefined,
      },
    },
  });
  const calls = await workflow.getAndResetSinkCalls();
  // Ignore LogTimestamp and workflowInfo for the purpose of this comparison
  calls.forEach((call) => {
    delete call.args[1]?.[LogTimestamp];
    delete (call as any).workflowInfo;
  });
  t.deepEqual(calls, [
    {
      ifaceName: '__temporal_logger',
      fnName: 'debug',
      args: [
        'Workflow started',
        {
          namespace: 'default',
          runId: 'beforeEach hook for logAndTimeout',
          taskQueue: 'test',
          workflowId: 'test-workflowId',
          workflowType: 'logAndTimeout',
          sdkComponent: SdkComponent.worker,
        },
      ],
    },
    {
      ifaceName: '__temporal_logger',
      fnName: 'info',
      args: [
        'logging before getting stuck',
        {
          namespace: 'default',
          runId: 'beforeEach hook for logAndTimeout',
          taskQueue: 'test',
          workflowId: 'test-workflowId',
          workflowType: 'logAndTimeout',
          sdkComponent: SdkComponent.workflow,
        },
      ],
    },
  ]);
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
            arguments: toPayloads(defaultPayloadConverter, 'signal'),
            versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
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
      jobs: [makeInitializeWorkflowJob(workflowType)],
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
      jobs: [makeInitializeWorkflowJob(workflowType)],
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
      jobs: [makeInitializeWorkflowJob(workflowType), makeNotifyHasPatchJob('my-change-id')],
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
              at $CLASS.nonRetryable (common/src/failure.ts)
              at tryToContinueAfterCompletion (test/src/workflows/try-to-continue-after-completion.ts)
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
    makeActivation(undefined, makeInitializeWorkflowJob(workflowType), {
      signalWorkflow: { signalName: 'someShallPass' },
    })
  );
  compareCompletion(t, completion, makeSuccess(undefined, [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]));
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

test('conditionRacer', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(
      t,
      completion,
      makeSuccess([makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs('1s') })])
    );
  }
  {
    const completion = await activate(
      t,
      makeActivation(
        Date.now(),
        {
          signalWorkflow: { signalName: 'unblock', input: [] },
        },
        makeFireTimerJob(1)
      )
    );
    compareCompletion(
      t,
      completion,
      makeSuccess(
        [makeCompleteWorkflowExecution(defaultPayloadConverter.toPayload(true))],
        [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]
      )
    );
  }
});

test('signalHandlersCanBeCleared', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(
      t,
      completion,
      makeSuccess([makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs('20ms') })])
    );
  }
  {
    const completion = await activate(
      t,
      makeActivation(
        Date.now(),
        {
          signalWorkflow: { signalName: 'unblock', input: [] },
        },
        {
          signalWorkflow: { signalName: 'unblock', input: [] },
        },
        {
          signalWorkflow: { signalName: 'unblock', input: [] },
        }
      )
    );
    compareCompletion(t, completion, makeSuccess([], [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]));
  }
  {
    const completion = await activate(t, makeFireTimer(1));
    compareCompletion(
      t,
      completion,
      makeSuccess(
        [makeStartTimerCommand({ seq: 2, startToFireTimeout: msToTs('1ms') })],
        [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]
      )
    );
  }
  {
    const completion = await activate(t, makeFireTimer(2));
    compareCompletion(
      t,
      completion,
      makeSuccess(
        [makeStartTimerCommand({ seq: 3, startToFireTimeout: msToTs('1ms') })],
        [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]
      )
    );
  }
  {
    const completion = await activate(t, makeFireTimer(3));
    compareCompletion(
      t,
      completion,
      makeSuccess(
        [makeCompleteWorkflowExecution(defaultPayloadConverter.toPayload(111))],
        [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]
      )
    );
  }
});

test('waitOnUser', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(
      t,
      completion,
      makeSuccess([makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs('30 days') })])
    );
  }
  {
    const completion = await activate(t, await makeSignalWorkflow('completeUserInteraction', []));
    compareCompletion(t, completion, makeSuccess(undefined, [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]));
  }
});

test('scopeCancelledWhileWaitingOnExternalWorkflowCancellation', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, makeStartWorkflow(workflowType));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        {
          requestCancelExternalWorkflowExecution: {
            seq: 1,
            workflowExecution: { namespace: 'default', workflowId: 'irrelevant' },
          },
        },
        {
          setPatchMarker: { deprecated: false, patchId: '__temporal_internal_connect_external_handle_cancel_to_scope' },
        },
        {
          completeWorkflowExecution: { result: defaultPayloadConverter.toPayload(undefined) },
        },
      ])
    );
  }
});

test('query not found - successString', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, makeActivation(undefined, makeInitializeWorkflowJob(workflowType)));
    compareCompletion(
      t,
      completion,
      makeSuccess([makeCompleteWorkflowExecution(defaultPayloadConverter.toPayload('success'))])
    );
  }
  {
    const completion = await activate(t, makeActivation(undefined, makeQueryWorkflowJob('qid', 'not-found')));
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeRespondToQueryCommand({
          queryId: 'qid',
          failed: {
            message:
              'Workflow did not register a handler for not-found. Registered queries: [__stack_trace __enhanced_stack_trace __temporal_workflow_metadata]',
            source: 'TypeScriptSDK',
            stackTrace:
              'ReferenceError: Workflow did not register a handler for not-found. Registered queries: [__stack_trace __enhanced_stack_trace __temporal_workflow_metadata]',
            applicationFailureInfo: {
              type: 'ReferenceError',
              nonRetryable: false,
            },
          },
        }),
      ])
    );
  }
});

test('Buffered signals are dispatched to correct handler and in correct order - signalsOrdering', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(
      t,
      makeActivation(
        undefined,
        makeInitializeWorkflowJob(workflowType),
        { signalWorkflow: { signalName: 'non-existant', input: toPayloads(defaultPayloadConverter, 1) } },
        { signalWorkflow: { signalName: 'signalA', input: toPayloads(defaultPayloadConverter, 2) } },
        { signalWorkflow: { signalName: 'signalA', input: toPayloads(defaultPayloadConverter, 3) } },
        { signalWorkflow: { signalName: 'signalC', input: toPayloads(defaultPayloadConverter, 4) } },
        { signalWorkflow: { signalName: 'signalB', input: toPayloads(defaultPayloadConverter, 5) } },
        { signalWorkflow: { signalName: 'non-existant', input: toPayloads(defaultPayloadConverter, 6) } },
        { signalWorkflow: { signalName: 'signalB', input: toPayloads(defaultPayloadConverter, 7) } }
      )
    );

    // Signal handlers will be registered in the following order:
    //
    // Registration of handler A => Processing of signalA#2
    // Deregistration of handler A => No more processing of signalA
    // Registration of handler B => Processing of signalB#5, signalB#7
    // Registration of default handler => Processing of the rest of signals, in numeric order
    // Registration of handler C => No signal pending for handler C

    compareCompletion(
      t,
      completion,
      makeSuccess(
        [
          makeCompleteWorkflowExecution(
            defaultPayloadConverter.toPayload([
              { handler: 'signalA', args: [2] },
              { handler: 'signalB', args: [5] },
              { handler: 'signalB', args: [7] },
              { handler: 'default', signalName: 'non-existant', args: [1] },
              { handler: 'default', signalName: 'signalA', args: [3] },
              { handler: 'default', signalName: 'signalC', args: [4] },
              { handler: 'default', signalName: 'non-existant', args: [6] },
            ] as ProcessedSignal[])
          ),
        ],
        [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]
      )
    );
  }
});

test('Buffered signals dispatch is reentrant  - signalsOrdering2', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(
      t,
      makeActivation(
        undefined,
        makeInitializeWorkflowJob(workflowType),
        { signalWorkflow: { signalName: 'non-existant', input: toPayloads(defaultPayloadConverter, 1) } },
        { signalWorkflow: { signalName: 'signalA', input: toPayloads(defaultPayloadConverter, 2) } },
        { signalWorkflow: { signalName: 'signalA', input: toPayloads(defaultPayloadConverter, 3) } },
        { signalWorkflow: { signalName: 'signalB', input: toPayloads(defaultPayloadConverter, 4) } },
        { signalWorkflow: { signalName: 'signalB', input: toPayloads(defaultPayloadConverter, 5) } },
        { signalWorkflow: { signalName: 'signalC', input: toPayloads(defaultPayloadConverter, 6) } },
        { signalWorkflow: { signalName: 'signalC', input: toPayloads(defaultPayloadConverter, 7) } }
      )
    );
    compareCompletion(
      t,
      completion,
      makeSuccess(
        [
          makeCompleteWorkflowExecution(
            defaultPayloadConverter.toPayload([
              { handler: 'signalA', args: [2] },
              { handler: 'signalB', args: [4] },
              { handler: 'signalC', args: [6] },
              { handler: 'default', signalName: 'non-existant', args: [1] },
              { handler: 'signalA', args: [3] },
              { handler: 'signalB', args: [5] },
              { handler: 'signalC', args: [7] },
            ] as ProcessedSignal[])
          ),
        ],
        [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]
      )
    );
  }
});

// Validate that issue #1474 is fixed in 1.11.0+
test("Pending promises can't unblock between signals and updates - 1.11.0+ - signalUpdateOrderingWorkflow", async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, {
      ...makeActivation(undefined, makeInitializeWorkflowJob(workflowType), {
        doUpdate: { name: 'fooUpdate', protocolInstanceId: '1', runValidator: false, id: 'first' },
      }),
      isReplaying: false,
    });
    compareCompletion(
      t,
      completion,
      makeSuccess([
        { updateResponse: { protocolInstanceId: '1', accepted: {} } },
        { updateResponse: { protocolInstanceId: '1', completed: defaultPayloadConverter.toPayload(1) } },
      ])
    );
  }

  {
    const completion = await activate(t, {
      ...makeActivation(
        undefined,
        { signalWorkflow: { signalName: 'fooSignal', input: [] } },
        { doUpdate: { name: 'fooUpdate', protocolInstanceId: '2', id: 'second' } }
      ),
      isReplaying: false,
    });
    compareCompletion(
      t,
      completion,
      makeSuccess(
        [
          { updateResponse: { protocolInstanceId: '2', accepted: {} } },
          { updateResponse: { protocolInstanceId: '2', completed: defaultPayloadConverter.toPayload(3) } },
          { completeWorkflowExecution: { result: defaultPayloadConverter.toPayload(3) } },
        ],
        [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]
      )
    );
  }
});

// Validate that issue #1474 legacy behavior is maintained when replaying from pre-1.11.0 history
test("Pending promises can't unblock between signals and updates - pre-1.11.0 - signalUpdateOrderingWorkflow", async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, {
      ...makeActivation(undefined, makeInitializeWorkflowJob(workflowType), {
        doUpdate: { name: 'fooUpdate', protocolInstanceId: '1', runValidator: false, id: 'first' },
      }),
      isReplaying: true,
    });
    compareCompletion(
      t,
      completion,
      makeSuccess([
        { updateResponse: { protocolInstanceId: '1', accepted: {} } },
        { updateResponse: { protocolInstanceId: '1', completed: defaultPayloadConverter.toPayload(1) } },
      ])
    );
  }

  {
    const completion = await activate(t, {
      ...makeActivation(
        undefined,
        { signalWorkflow: { signalName: 'fooSignal', input: [] } },
        { doUpdate: { name: 'fooUpdate', protocolInstanceId: '2', id: 'second' } }
      ),
      isReplaying: true,
    });
    compareCompletion(
      t,
      completion,
      makeSuccess([
        { completeWorkflowExecution: { result: defaultPayloadConverter.toPayload(2) } },
        { updateResponse: { protocolInstanceId: '2', accepted: {} } },
        { updateResponse: { protocolInstanceId: '2', completed: defaultPayloadConverter.toPayload(3) } },
      ])
    );
  }
});

test('Signals/Updates/Activities/Timers have coherent promise completion ordering (no signal) - pre-1.11.0 compatibility - signalsActivitiesTimersPromiseOrdering', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, {
      ...makeActivation(undefined, makeInitializeWorkflowJob(workflowType)),
      isReplaying: true,
    });
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(100) }),
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'myActivity',
          scheduleToCloseTimeout: msToTs('10s'),
          taskQueue: 'test-activity',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
        }),
      ])
    );
  }
  {
    const completion = await activate(t, {
      ...makeActivation(
        undefined,
        { doUpdate: { id: 'first', name: 'aaUpdate', protocolInstanceId: '1' } },
        makeFireTimerJob(1),
        makeResolveActivityJob(1, { completed: {} })
      ),
      isReplaying: true,
    });
    compareCompletion(
      t,
      completion,
      makeSuccess([
        { updateResponse: { protocolInstanceId: '1', accepted: {} } },
        { updateResponse: { protocolInstanceId: '1', completed: defaultPayloadConverter.toPayload(undefined) } },
        makeCompleteWorkflowExecution(defaultPayloadConverter.toPayload([false, true, true, true])),
      ])
    );
  }
});

test('Signals/Updates/Activities/Timers have coherent promise completion ordering (w/ signals) - pre-1.11.0 compatibility - signalsActivitiesTimersPromiseOrdering', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, {
      ...makeActivation(undefined, makeInitializeWorkflowJob(workflowType)),
      isReplaying: true,
    });
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(100) }),
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'myActivity',
          scheduleToCloseTimeout: msToTs('10s'),
          taskQueue: 'test-activity',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
        }),
      ])
    );
  }
  {
    const completion = await activate(t, {
      ...makeActivation(
        undefined,
        makeSignalWorkflowJob('aaSignal', []),
        { doUpdate: { id: 'first', name: 'aaUpdate', protocolInstanceId: '1' } },
        makeFireTimerJob(1),
        makeResolveActivityJob(1, { completed: {} })
      ),
      isReplaying: true,
    });
    compareCompletion(
      t,
      completion,
      makeSuccess([
        // Note the missing update responses here; this is due to #1474. The fact that the activity
        // and timer completions have not been observed before the workflow completed is a related but
        // distinct issue. But are resolved by the ProcessWorkflowActivationJobsAsSingleBatch fix.
        makeCompleteWorkflowExecution(defaultPayloadConverter.toPayload([true, false, false, false])),
        { updateResponse: { protocolInstanceId: '1', accepted: {} } },
        { updateResponse: { protocolInstanceId: '1', completed: defaultPayloadConverter.toPayload(undefined) } },
      ])
    );
  }
});

test('Signals/Updates/Activities/Timers have coherent promise completion ordering (w/ signals) - signalsActivitiesTimersPromiseOrdering', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, {
      ...makeActivation(undefined, makeInitializeWorkflowJob(workflowType)),
    });
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(100) }),
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'myActivity',
          scheduleToCloseTimeout: msToTs('10s'),
          taskQueue: 'test-activity',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
        }),
      ])
    );
  }
  {
    const completion = await activate(t, {
      ...makeActivation(
        undefined,
        makeSignalWorkflowJob('aaSignal', []),
        { doUpdate: { id: 'first', name: 'aaUpdate', protocolInstanceId: '1' } },
        makeFireTimerJob(1),
        makeResolveActivityJob(1, { completed: {} })
      ),
    });
    compareCompletion(
      t,
      completion,
      makeSuccess(
        [
          { updateResponse: { protocolInstanceId: '1', accepted: {} } },
          { updateResponse: { protocolInstanceId: '1', completed: defaultPayloadConverter.toPayload(undefined) } },
          makeCompleteWorkflowExecution(defaultPayloadConverter.toPayload([true, true, true, true])),
        ],
        [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]
      )
    );
  }
});

test('Signals/Updates/Activities/Timers - Trace promises completion order - pre-1.11.0 compatibility - signalsActivitiesTimersPromiseOrderingTracer', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, {
      ...makeActivation(undefined, makeInitializeWorkflowJob(workflowType)),
      isReplaying: true,
    });
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(1) }),
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'myActivity',
          scheduleToCloseTimeout: msToTs('1s'),
          taskQueue: 'test',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
        }),
      ])
    );
  }
  {
    const completion = await activate(t, {
      ...makeActivation(
        undefined,
        makeSignalWorkflowJob('aaSignal', ['signal1']),
        makeUpdateActivationJob('first', '1', 'aaUpdate', ['update1']),
        makeSignalWorkflowJob('aaSignal', ['signal2']),
        makeUpdateActivationJob('second', '2', 'aaUpdate', ['update2']),
        makeFireTimerJob(1),
        makeResolveActivityJob(1, { completed: {} })
      ),
      isReplaying: true,
    });
    compareCompletion(
      t,
      completion,
      makeSuccess([
        { updateResponse: { protocolInstanceId: '1', accepted: {} } },
        { updateResponse: { protocolInstanceId: '2', accepted: {} } },
        { updateResponse: { protocolInstanceId: '1', completed: defaultPayloadConverter.toPayload(undefined) } },
        { updateResponse: { protocolInstanceId: '2', completed: defaultPayloadConverter.toPayload(undefined) } },
        makeCompleteWorkflowExecution(
          defaultPayloadConverter.toPayload(
            [
              // Signals first (sync part, then microtasks)
              'signal1.sync, signal2.sync',
              'signal1.1, signal2.1, signal1.2, signal2.2, signal1.3, signal2.3, signal1.4, signal2.4',

              // Then update (sync part first), then microtasks for update+timers+activities
              'update1.sync, update2.sync',
              'update1.1, update2.1, timer.1, activity.1',
              'update1.2, update2.2, timer.2, activity.2',
              'update1.3, update2.3, timer.3, activity.3',
              'update1.4, update2.4, timer.4, activity.4',
            ].flatMap((x) => x.split(', '))
          )
        ),
      ])
    );
  }
});

test('Signals/Updates/Activities/Timers - Trace promises completion order - 1.11.0+ - signalsActivitiesTimersPromiseOrderingTracer', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(t, {
      ...makeActivation(undefined, makeInitializeWorkflowJob(workflowType)),
    });
    compareCompletion(
      t,
      completion,
      makeSuccess([
        makeStartTimerCommand({ seq: 1, startToFireTimeout: msToTs(1) }),
        makeScheduleActivityCommand({
          seq: 1,
          activityId: '1',
          activityType: 'myActivity',
          scheduleToCloseTimeout: msToTs('1s'),
          taskQueue: 'test',
          doNotEagerlyExecute: false,
          versioningIntent: coresdk.common.VersioningIntent.UNSPECIFIED,
        }),
      ])
    );
  }
  {
    const completion = await activate(t, {
      ...makeActivation(
        undefined,
        makeSignalWorkflowJob('aaSignal', ['signal1']),
        makeUpdateActivationJob('first', '1', 'aaUpdate', ['update1']),
        makeSignalWorkflowJob('aaSignal', ['signal2']),
        makeUpdateActivationJob('second', '2', 'aaUpdate', ['update2']),
        makeFireTimerJob(1),
        makeResolveActivityJob(1, { completed: {} })
      ),
    });
    compareCompletion(
      t,
      completion,
      makeSuccess(
        [
          { updateResponse: { protocolInstanceId: '1', accepted: {} } },
          { updateResponse: { protocolInstanceId: '2', accepted: {} } },
          { updateResponse: { protocolInstanceId: '1', completed: defaultPayloadConverter.toPayload(undefined) } },
          { updateResponse: { protocolInstanceId: '2', completed: defaultPayloadConverter.toPayload(undefined) } },
          makeCompleteWorkflowExecution(
            defaultPayloadConverter.toPayload(
              [
                'signal1.sync, update1.sync, signal2.sync, update2.sync',
                'signal1.1, update1.1, signal2.1, update2.1, timer.1, activity.1',
                'signal1.2, update1.2, signal2.2, update2.2, timer.2, activity.2',
                'signal1.3, update1.3, signal2.3, update2.3, timer.3, activity.3',
                'signal1.4, update1.4, signal2.4, update2.4, timer.4, activity.4',
              ].flatMap((x) => x.split(', '))
            )
          ),
        ],
        [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]
      )
    );
  }
});

test('Buffered updates are dispatched in the correct order - updatesOrdering', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(
      t,
      makeActivation(
        undefined,
        makeInitializeWorkflowJob(workflowType),
        makeUpdateActivationJob('1', '1', 'non-existant', [1]),
        makeUpdateActivationJob('2', '2', 'updateA', [2]),
        makeUpdateActivationJob('3', '3', 'updateA', [3]),
        makeUpdateActivationJob('4', '4', 'updateC', [4]),
        makeUpdateActivationJob('5', '5', 'updateB', [5]),
        makeUpdateActivationJob('6', '6', 'non-existant', [6]),
        makeUpdateActivationJob('7', '7', 'updateB', [7])
      )
    );

    // The activation above:
    // - initializes the workflow
    // - buffers all its updates (we attempt update jobs first, but since there are no handlers, they get buffered)
    // - enters the workflow code
    // - workflow code sets handler for updateA
    //   - handler is registered for updateA
    //   - we attempt to dispatch buffered updates
    //     - buffered updates for handler A are *accepted* but not executed
    //    (executing an update is a promise/async, so it instead goes on the node event queue)
    // - we continue/re-enter the workflow code
    // - ...and do the same pattern for updateB, the default update handler, the updateC
    // - once updates have been accepted, node processes the waiting events in its queue (the waiting updates)
    //   - these are processesed in FIFO order, so we get execution for updateA, then updateB, the default handler, then updateC

    // As such, the expected order of these updates is the order that the handlers were registered.
    // Note that because the default handler was registered *before* updateC, all remaining buffered updates were dispatched
    // to it, including the update for updateC.

    compareCompletion(
      t,
      completion,
      makeSuccess(
        [
          // FIFO accepted order
          makeUpdateAcceptedResponse('2'),
          makeUpdateAcceptedResponse('3'),
          makeUpdateAcceptedResponse('5'),
          makeUpdateAcceptedResponse('7'),
          makeUpdateAcceptedResponse('1'),
          makeUpdateAcceptedResponse('4'),
          makeUpdateAcceptedResponse('6'),
          // FIFO executed order
          makeUpdateCompleteResponse('2', { handler: 'updateA', args: [2] }),
          makeUpdateCompleteResponse('3', { handler: 'updateA', args: [3] }),
          makeUpdateCompleteResponse('5', { handler: 'updateB', args: [5] }),
          makeUpdateCompleteResponse('7', { handler: 'updateB', args: [7] }),
          makeUpdateCompleteResponse('1', { handler: 'default', updateName: 'non-existant', args: [1] }),
          // updateC handled by default handler.
          makeUpdateCompleteResponse('4', { handler: 'default', updateName: 'updateC', args: [4] }),
          makeUpdateCompleteResponse('6', { handler: 'default', updateName: 'non-existant', args: [6] }),
          // No expected update response from updateC handler
          makeCompleteWorkflowExecution(),
        ]
        // [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]
      )
    );
  }
});

test('Buffered updates are reentrant - updatesAreReentrant', async (t) => {
  const { workflowType } = t.context;
  {
    const completion = await activate(
      t,
      makeActivation(
        undefined,
        makeInitializeWorkflowJob(workflowType),
        makeUpdateActivationJob('1', '1', 'non-existant', [1]),
        makeUpdateActivationJob('2', '2', 'updateA', [2]),
        makeUpdateActivationJob('3', '3', 'updateA', [3]),
        makeUpdateActivationJob('4', '4', 'updateC', [4]),
        makeUpdateActivationJob('5', '5', 'updateB', [5]),
        makeUpdateActivationJob('6', '6', 'non-existant', [6]),
        makeUpdateActivationJob('7', '7', 'updateB', [7]),
        makeUpdateActivationJob('8', '8', 'updateC', [8])
      )
    );

    // The activation above:
    // - initializes the workflow
    // - buffers all its updates (we attempt update jobs first, but since there are no handlers, they get buffered)
    // - enters the workflow code
    // - workflow code sets handler for updateA
    //   - handler is registered for updateA
    //   - we attempt to dispatch buffered updates
    //     - buffered updates for handler A are *accepted* but not executed
    //    (executing an update is a promise/async, so it instead goes on the node event queue)
    //  - however, there is no more workflow code, node dequues event queue and we immediately run the update handler
    //    (we begin executing the update which...)
    //    - deletes the current handler and registers the next one (updateB)
    //  - this pattern repeats (updateA -> updateB -> updateC -> default) until there are no more updates to handle
    //  - at this point, all updates have been accepted and are executing
    //  - due to the call order in the workflow, the completion order of the updates follows the call stack, LIFO

    // This workflow is interesting in that updates are accepted FIFO, but executed LIFO

    compareCompletion(
      t,
      completion,
      makeSuccess(
        [
          // FIFO accepted order
          makeUpdateAcceptedResponse('2'),
          makeUpdateAcceptedResponse('5'),
          makeUpdateAcceptedResponse('4'),
          makeUpdateAcceptedResponse('1'),
          makeUpdateAcceptedResponse('3'),
          makeUpdateAcceptedResponse('7'),
          makeUpdateAcceptedResponse('8'),
          makeUpdateAcceptedResponse('6'),
          // LIFO executed order
          makeUpdateCompleteResponse('6', { handler: 'default', updateName: 'non-existant', args: [6] }),
          makeUpdateCompleteResponse('8', { handler: 'updateC', args: [8] }),
          makeUpdateCompleteResponse('7', { handler: 'updateB', args: [7] }),
          makeUpdateCompleteResponse('3', { handler: 'updateA', args: [3] }),
          makeUpdateCompleteResponse('1', { handler: 'default', updateName: 'non-existant', args: [1] }),
          makeUpdateCompleteResponse('4', { handler: 'updateC', args: [4] }),
          makeUpdateCompleteResponse('5', { handler: 'updateB', args: [5] }),
          makeUpdateCompleteResponse('2', { handler: 'updateA', args: [2] }),
          makeCompleteWorkflowExecution(),
        ]
        // [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch]
      )
    );
  }
});
