// DONOTMERGE -- DO NOT REVIEW THIS FILE

import { randomUUID } from 'crypto';
import Long from 'long';
import { ExecutionContext, TestFn } from 'ava';
import { msToTs } from '@temporalio/common/lib/time';
import { coresdk } from '@temporalio/proto';
import { ReusableVMWorkflowCreator } from '@temporalio/worker/lib/workflow/reusable-vm';
import { WorkflowCodeBundler } from '@temporalio/worker/lib/workflow/bundler';
import { parseWorkflowCode } from '@temporalio/worker/lib/worker';
import { VMWorkflow, VMWorkflowCreator } from '@temporalio/worker/lib/workflow/vm';
import * as wf from '@temporalio/workflow';
import { test as anyTest, bundlerOptions, REUSE_V8_CONTEXT } from './helpers';

export interface Context {
  workflowCreator: VMWorkflowCreator | ReusableVMWorkflowCreator;
}

const test = anyTest as TestFn<Context>;

test.before(async (t) => {
  const bundler = new WorkflowCodeBundler({
    workflowsPath: __filename,
    ignoreModules: [...bundlerOptions.ignoreModules],
  });
  const workflowBundle = parseWorkflowCode((await bundler.createBundle()).code);
  t.context.workflowCreator = REUSE_V8_CONTEXT
    ? await ReusableVMWorkflowCreator.create(workflowBundle, 400, new Set())
    : await VMWorkflowCreator.create(workflowBundle, 400, new Set());
});

test.after.always(async (t) => {
  await t.context.workflowCreator.destroy();
});

async function createWorkflow(
  t: ExecutionContext<Context>,
  workflowType: wf.Workflow
): Promise<{ workflow: VMWorkflow; info: wf.WorkflowInfo }> {
  const { workflowCreator } = t.context;
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
    historyLength: 3,
    historySize: 300,
    continueAsNewSuggested: false,
    unsafe: { isReplaying: false, now: Date.now },
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

async function activate(
  t: ExecutionContext<Context>,
  workflow: VMWorkflow,
  activation: coresdk.workflow_activation.IWorkflowActivation
) {
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

test.serial('xxx', async (t) => {
  t.timeout(60_000);

  const { workflow, info } = await createWorkflow(t, xxxWorkflow);
  let lastCompletion = await activate(t, workflow, makeStartWorkflow(info));

  function getTimerSeq(): number {
    const startTimerCommand = lastCompletion.completion.successful?.commands?.filter((c) => c.startTimer)[0];
    return startTimerCommand?.startTimer?.seq || 0;
  }

  const startTime = Date.now();
  for (let i = 0; i < 30000; i++) {
    lastCompletion = await activate(t, workflow, makeFireTimer(info, getTimerSeq()));
    if (i % 10000 === 0) {
      console.log(` ${i}: ${Date.now() - startTime} - ${(Date.now() - startTime) / i}ms per activation`);
    }
  }
  console.log(` Completed: ${Date.now() - startTime} - ${(Date.now() - startTime) / 30000}ms per activation`);

  t.pass();
});

export async function xxxWorkflow(): Promise<void> {
  // We don't care about history size, as this workflow is only to be used with synthetic activations
  for (;;) {
    await wf.sleep(1);
  }
}
