import { randomUUID } from 'crypto';
import Long from 'long';
import { msToTs } from '@temporalio/common/lib/time';
import { coresdk } from '@temporalio/proto';
import { ReusableVMWorkflowCreator } from '@temporalio/worker/lib/workflow/reusable-vm';
import { WorkflowCodeBundler } from '@temporalio/worker/lib/workflow/bundler';
import { parseWorkflowCode } from '@temporalio/worker/lib/worker';
import { VMWorkflow, VMWorkflowCreator } from '@temporalio/worker/lib/workflow/vm';
import * as wf from '@temporalio/workflow';
import { TypedSearchAttributes } from '@temporalio/common';

// WARNING: This file is a quick and dirty utility to run Workflow Activation performance testing
//          localy. It is not part of our regular test suite and hasn't been reviewed.

function isSet(env: string | undefined, def: boolean): boolean {
  if (env === undefined) return def;
  env = env.toLocaleLowerCase();
  return env === '1' || env === 't' || env === 'true';
}

export const REUSE_V8_CONTEXT = wf.inWorkflowContext() || isSet(process.env.REUSE_V8_CONTEXT, true);

export const bundlerOptions = {
  // This is a bit ugly but it does the trick, when a test that includes workflow
  // code tries to import a forbidden workflow module, add it to this list:
  ignoreModules: [
    '@temporalio/common/lib/internal-non-workflow',
    '@temporalio/activity',
    '@temporalio/client',
    '@temporalio/testing',
    '@temporalio/worker',
    '@temporalio/proto',
    'inspector',
    'ava',
    'crypto',
    'timers/promises',
    'fs',
    'module',
    'path',
    'perf_hooks',
    'stack-utils',
    '@grpc/grpc-js',
    'async-retry',
    'uuid',
    'net',
    'fs/promises',
    '@temporalio/worker/lib/workflow/bundler',
    require.resolve('./activities'),
  ],
};

export interface Context {
  workflowCreator: VMWorkflowCreator | ReusableVMWorkflowCreator;
}

if (!wf.inWorkflowContext()) {
  async function runPerfTest() {
    const bundler = new WorkflowCodeBundler({
      workflowsPath: __filename,
      ignoreModules: [...bundlerOptions.ignoreModules],
    });

    const workflowBundle = parseWorkflowCode((await bundler.createBundle()).code);

    const workflowCreator = REUSE_V8_CONTEXT
      ? await ReusableVMWorkflowCreator.create(workflowBundle, 400, new Set())
      : await VMWorkflowCreator.create(workflowBundle, 400, new Set());

    async function createWorkflow(workflowType: wf.Workflow): Promise<{ workflow: VMWorkflow; info: wf.WorkflowInfo }> {
      const startTime = Date.now();
      const runId = randomUUID(); // That one is using a strong entropy; could this slow doen our tests?

      const info: wf.WorkflowInfo = {
        workflowType: workflowType.name,
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
        unsafe: { isReplaying: false, isReplayingHistoryEvents: false, now: Date.now },
        startTime: new Date(),
        runStartTime: new Date(),
      };

      const workflow = (await workflowCreator.createWorkflow({
        info,
        randomnessSeed: Long.fromInt(1337).toBytes(),
        now: startTime,
        showStackTraceSources: true,
      })) as VMWorkflow;

      return { workflow, info };
    }

    async function activate(workflow: VMWorkflow, activation: coresdk.workflow_activation.IWorkflowActivation) {
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
      const sinkCalls = await workflow.getAndResetSinkCalls();

      return { completion, sinkCalls };
    }

    function makeActivation(
      info: wf.WorkflowInfo,
      timestamp: number = Date.now(),
      ...jobs: coresdk.workflow_activation.IWorkflowActivationJob[]
    ): coresdk.workflow_activation.IWorkflowActivation {
      return {
        runId: info.runId,
        timestamp: msToTs(timestamp),
        jobs,
      };
    }
    function makeStartWorkflow(info: wf.WorkflowInfo): coresdk.workflow_activation.IWorkflowActivation {
      const timestamp = Date.now();
      return makeActivation(info, timestamp, makeInitializeWorkflowJob(info));
    }

    function makeInitializeWorkflowJob(info: wf.WorkflowInfo): {
      initializeWorkflow: coresdk.workflow_activation.IInitializeWorkflow;
    } {
      return {
        initializeWorkflow: { workflowId: info.workflowId, workflowType: info.workflowType, arguments: [] },
      };
    }

    function makeFireTimer(
      info: wf.WorkflowInfo,
      seq: number,
      timestamp: number = Date.now()
    ): coresdk.workflow_activation.IWorkflowActivation {
      return makeActivation(info, timestamp, makeFireTimerJob(seq));
    }

    function makeFireTimerJob(seq: number): coresdk.workflow_activation.IWorkflowActivationJob {
      return {
        fireTimer: { seq },
      };
    }

    const workflows = [];
    for (let i = 0; i < 5; i++) {
      const { workflow, info } = await createWorkflow(xxxWorkflow);
      let lastCompletion = await activate(workflow, makeStartWorkflow(info));

      function getTimerSeq(): number {
        const startTimerCommand = lastCompletion.completion.successful?.commands?.filter((c) => c.startTimer)[0];
        return startTimerCommand?.startTimer?.seq || 0;
      }

      async function doActivate() {
        lastCompletion = await activate(workflow, makeFireTimer(info, getTimerSeq()));
      }

      workflows.push({ doActivate });
    }

    const startTime = Date.now();
    for (let i = 1; i <= 50_000; i++) {
      await workflows[Math.floor(Math.random() * workflows.length)].doActivate();
      if (i % 10_000 === 0) {
        console.log(` ${i}: ${Math.round(((Date.now() - startTime) / i) * 1000)}us per activation`);
      }
    }
  }

  runPerfTest()
    .catch((err) => {
      console.error(err);
    })
    .finally(() => {});
}

export async function xxxWorkflow(): Promise<void> {
  // We don't care about history size, as this workflow is only to be used with synthetic activations
  for (;;) {
    await wf.sleep(1);
  }
}
