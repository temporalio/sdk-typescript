import path from 'node:path';
import vm from 'node:vm';
import anyTest, { TestFn } from 'ava';
import Long from 'long';
import { TypedSearchAttributes } from '@temporalio/common';
import { msToTs } from '@temporalio/common/lib/time';
import { coresdk } from '@temporalio/proto';
import { WorkflowCodeBundler } from '@temporalio/worker/lib/workflow/bundler';
import { ReusableVMWorkflow, ReusableVMWorkflowCreator } from '@temporalio/worker/lib/workflow/reusable-vm';
import { VMWorkflow, VMWorkflowCreator } from '@temporalio/worker/lib/workflow/vm';
import { parseWorkflowCode } from '@temporalio/worker/lib/worker';
import { REUSE_V8_CONTEXT } from './helpers';

interface Context {
  workflowCreator: TestVMWorkflowCreator | TestReusableVMWorkflowCreator;
  nextRunNumber: number;
}

interface DriveWorkflowOptions {
  randomnessSeed?: number[];
  makeTimerActivationJobs?: (
    startedTimers: number[],
    timerActivationIndex: number
  ) => coresdk.workflow_activation.IWorkflowActivationJob[];
}

type TestWorkflow = VMWorkflow | ReusableVMWorkflow;

const test = anyTest as TestFn<Context>;

// These tests need to observe randomness emitted from workflow code plus inbound,
// outbound, and internals interceptors. Capturing labeled console output gives a
// single test-only observation channel across all of those hook points without
// adding return-value plumbing to the implementations under test.
function injectCustomConsole(logsGetter: (runId: string) => unknown[][], context: vm.Context): void {
  context.console = {
    log(...args: unknown[]) {
      const { runId } = context.__TEMPORAL_ACTIVATOR__.info;
      logsGetter(runId).push(args);
    },
  };
}

class TestVMWorkflowCreator extends VMWorkflowCreator {
  public logs: Record<string, unknown[][]> = {};

  override injectGlobals(context: vm.Context): void {
    super.injectGlobals(context);
    injectCustomConsole((runId) => this.logs[runId], context);
  }
}

class TestReusableVMWorkflowCreator extends ReusableVMWorkflowCreator {
  public logs: Record<string, unknown[][]> = {};

  override injectGlobals(context: vm.Context): void {
    super.injectGlobals(context);
    injectCustomConsole((runId) => this.logs[runId], context);
  }
}

test.before(async (t) => {
  const workflowsPath = path.join(__dirname, 'workflows');
  const workflowInterceptorModules = [path.join(workflowsPath, 'random-stream-interceptors')];
  const bundler = new WorkflowCodeBundler({ workflowsPath, workflowInterceptorModules });
  const workflowBundle = parseWorkflowCode((await bundler.createBundle()).code);
  t.context.workflowCreator = REUSE_V8_CONTEXT
    ? await TestReusableVMWorkflowCreator.create(workflowBundle, 400, new Set())
    : await TestVMWorkflowCreator.create(workflowBundle, 400, new Set());
  t.context.nextRunNumber = 0;
});

test.after.always(async (t) => {
  await t.context.workflowCreator.destroy();
});

function makeActivation(
  runId: string,
  timestamp: number = Date.now(),
  ...jobs: coresdk.workflow_activation.IWorkflowActivationJob[]
): coresdk.workflow_activation.IWorkflowActivation {
  return {
    runId,
    timestamp: msToTs(timestamp),
    jobs,
  };
}

function makeStartWorkflow(runId: string, workflowType: string): coresdk.workflow_activation.IWorkflowActivation {
  return makeActivation(runId, Date.now(), {
    initializeWorkflow: { workflowId: `${runId}-workflow`, workflowType },
  });
}

function getActivationJobPriority(job: coresdk.workflow_activation.IWorkflowActivationJob): number {
  if (job.initializeWorkflow) return 0;
  if (job.notifyHasPatch) return 1;
  if (job.updateRandomSeed) return 2;
  if (job.signalWorkflow || job.doUpdate) return 3;
  if (job.resolveActivity?.isLocal) return 5;
  return 4;
}

function sortActivationJobs(
  jobs: coresdk.workflow_activation.IWorkflowActivationJob[]
): coresdk.workflow_activation.IWorkflowActivationJob[] {
  return [...jobs].sort((left, right) => getActivationJobPriority(left) - getActivationJobPriority(right));
}

function extractNumbers(logs: unknown[][], label: string): number[] {
  return logs
    .filter((entry) => entry[0] === label)
    .map((entry) => {
      const value = entry[1];
      if (typeof value !== 'number') {
        throw new TypeError(`Expected ${label} log entry to contain a number, got ${typeof value}`);
      }
      return value;
    });
}

function extractStrings(logs: unknown[][], label: string): string[] {
  return logs
    .filter((entry) => entry[0] === label)
    .map((entry) => {
      const value = entry[1];
      if (typeof value !== 'string') {
        throw new TypeError(`Expected ${label} log entry to contain a string, got ${typeof value}`);
      }
      return value;
    });
}

async function createWorkflow(
  t: Context,
  workflowType: string,
  { randomnessSeed = Long.fromInt(1337).toBytes() }: Pick<DriveWorkflowOptions, 'randomnessSeed'> = {}
): Promise<{ runId: string; logs: unknown[][]; workflow: TestWorkflow }> {
  const { workflowCreator } = t;
  const runId = `random-stream-test-${t.nextRunNumber++}-${workflowType}`;
  const logs: unknown[][] = [];
  workflowCreator.logs[runId] = logs;
  const workflow = (await workflowCreator.createWorkflow({
    info: {
      workflowType,
      runId,
      workflowId: `${runId}-workflow-id`,
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
      targetWorkerDeploymentVersionChanged: false,
      unsafe: { isReplaying: false, isReplayingHistoryEvents: false, now: Date.now },
      startTime: new Date(),
      runStartTime: new Date(),
    },
    randomnessSeed,
    now: Date.now(),
    showStackTraceSources: true,
  })) as TestWorkflow;
  return { runId, logs, workflow };
}

async function driveWorkflow(t: Context, workflowType: string, options: DriveWorkflowOptions = {}): Promise<unknown[][]> {
  const { runId, logs, workflow } = await createWorkflow(t, workflowType, options);
  try {
    let completion = await workflow.activate(
      coresdk.workflow_activation.WorkflowActivation.fromObject(makeStartWorkflow(runId, workflowType))
    );
    let timerActivationIndex = 0;

    for (;;) {
      if (completion.failed) {
        throw new Error(`Workflow ${workflowType} failed unexpectedly: ${completion.failed.failure?.message ?? 'unknown error'}`);
      }

      const startedTimers = (completion.successful?.commands ?? []).flatMap((command) =>
        command.startTimer?.seq == null ? [] : [command.startTimer.seq]
      );

      if (startedTimers.length === 0) {
        return logs;
      }

      completion = await workflow.activate(
        coresdk.workflow_activation.WorkflowActivation.fromObject(
          makeActivation(
            runId,
            Date.now(),
            ...sortActivationJobs([
              ...(options.makeTimerActivationJobs?.(startedTimers, timerActivationIndex++) ?? []),
              ...startedTimers.map((seq) => ({
                fireTimer: { seq },
              })),
            ])
          )
        )
      );
    }
  } finally {
    await workflow.dispose();
  }
}

test.serial('main workflow randomness remains deterministic without plugin random streams', async (t) => {
  const first = extractNumbers(await driveWorkflow(t.context, 'randomStreamMainBaselineWithSleep'), 'workflow');
  const second = extractNumbers(await driveWorkflow(t.context, 'randomStreamMainBaselineWithSleep'), 'workflow');
  t.deepEqual(first, second);
});

test.serial('plugin named streams do not consume the workflow random stream', async (t) => {
  const baseline = extractNumbers(await driveWorkflow(t.context, 'randomStreamMainBaselineWithSleep'), 'workflow');
  const actual = extractNumbers(await driveWorkflow(t.context, 'randomStreamPluginNamedStreamDoesNotConsumeMain'), 'workflow');
  t.deepEqual(actual, baseline);
});

test.serial('plugin named streams are isolated from one another', async (t) => {
  const baseline = extractNumbers(
    await driveWorkflow(t.context, 'randomStreamPluginNamedStreamNamespaceBaseline'),
    'plugin-a'
  );
  const actual = extractNumbers(
    await driveWorkflow(t.context, 'randomStreamPluginNamedStreamNamespaceIsolation'),
    'plugin-a'
  );
  t.deepEqual(actual, baseline);
});

test.serial('plugin named streams preserve state across activations', async (t) => {
  const baseline = extractNumbers(await driveWorkflow(t.context, 'randomStreamPluginActivationBaseline'), 'plugin-activation');
  const actual = extractNumbers(
    await driveWorkflow(t.context, 'randomStreamPluginActivationWithWorkflowInterference'),
    'plugin-activation'
  );
  t.deepEqual(actual, baseline);
});

test.serial('plugin-scoped randomness around next does not perturb workflow Math.random', async (t) => {
  const baseline = extractNumbers(await driveWorkflow(t.context, 'randomStreamMainBaselineWithSleep'), 'workflow');
  const logs = await driveWorkflow(t.context, 'randomStreamPluginScopedMathAroundNext');
  t.is(extractNumbers(logs, 'plugin-scoped').length, 2);
  t.deepEqual(extractNumbers(logs, 'workflow'), baseline);
});

test.serial('plugin-scoped randomness around next does not perturb workflow uuid4', async (t) => {
  const baseline = extractStrings(await driveWorkflow(t.context, 'randomStreamUuidBaselineWithSleep'), 'workflow-uuid');
  const logs = await driveWorkflow(t.context, 'randomStreamPluginScopedUuidAroundNext');
  t.is(extractNumbers(logs, 'plugin-scoped').length, 2);
  t.deepEqual(extractStrings(logs, 'workflow-uuid'), baseline);
});

test.serial('plugin named streams in outbound interceptors do not perturb workflow randomness', async (t) => {
  const baseline = extractNumbers(await driveWorkflow(t.context, 'randomStreamMainBaselineWithSleep'), 'workflow');
  const logs = await driveWorkflow(t.context, 'randomStreamPluginOutboundTimerNamedStream');
  t.is(extractNumbers(logs, 'plugin-outbound').length, 1);
  t.deepEqual(extractNumbers(logs, 'workflow'), baseline);
});

test.serial('plugin cached named streams are reseeded when core updates the workflow random seed', async (t) => {
  const updatedRandomnessSeed = Long.fromInt(7331);
  const expected = extractNumbers(
    await driveWorkflow(t.context, 'randomStreamPluginCachedStreamSingleActivation', {
      randomnessSeed: updatedRandomnessSeed.toBytes(),
    }),
    'plugin-conclude'
  );
  const actual = extractNumbers(
    await driveWorkflow(t.context, 'randomStreamPluginCachedStreamAcrossActivations', {
      makeTimerActivationJobs: (_startedTimers, timerActivationIndex) =>
        timerActivationIndex === 0 ? [{ updateRandomSeed: { randomnessSeed: updatedRandomnessSeed } }] : [],
    }),
    'plugin-conclude'
  );

  t.is(actual.length, 2);
  t.deepEqual(actual[1], expected[0]);
});
