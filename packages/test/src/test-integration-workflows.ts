import { randomUUID } from 'crypto';
import { TestFn } from 'ava';
import { WorkflowFailedError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode } from '@temporalio/worker';
import * as workflow from '@temporalio/workflow';
import { test as anyTest, bundlerOptions, Worker } from './helpers';

interface Context {
  env: TestWorkflowEnvironment;
  taskQueue: string;
  createWorker(): Promise<Worker>;
}

const test = anyTest as TestFn<Context>;

test.before(async (t) => {
  const env = await TestWorkflowEnvironment.createLocal();
  const taskQueue = 'test';
  const workflowBundle = await bundleWorkflowCode({
    ...bundlerOptions,
    workflowsPath: __filename,
  });
  async function createWorker() {
    return await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
    });
  }
  t.context = {
    env,
    taskQueue,
    createWorker,
  };
});

test.after.always(async (t) => {
  await t.context.env.teardown();
});

export async function parent(): Promise<void> {
  await workflow.startChild(child, { workflowId: 'child' });
  await workflow.startChild(child, { workflowId: 'child' });
}

export async function child(): Promise<void> {
  await workflow.CancellationScope.current().cancelRequested;
}

test('Workflow fails if it tries to start a child with an existing workflow ID', async (t) => {
  const { createWorker, taskQueue, env } = t.context;
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const err = await t.throwsAsync(env.client.workflow.execute(parent, { taskQueue, workflowId: randomUUID() }), {
      instanceOf: WorkflowFailedError,
    });
    t.true(
      err instanceof WorkflowFailedError &&
        err.cause?.name === 'TemporalFailure' &&
        err.cause?.message === 'Workflow execution already started'
    );
  });
});
