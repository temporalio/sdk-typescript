import { randomUUID } from 'crypto';
import { TestFn } from 'ava';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { ApplicationFailure, arrayFromPayloads } from '@temporalio/common';
import { sleep } from '@temporalio/workflow';
import { WorkflowFailedError } from '@temporalio/client';
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
  async function createWorker() {
    return await Worker.create({
      connection: env.nativeConnection,
      workflowsPath: __filename,
      taskQueue,
      bundlerOptions,
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

export async function globalMutator(): Promise<number> {
  const global = globalThis as { a?: number };
  global.a = (global.a || 0) + 1;
  await sleep(1);
  global.a = (global.a || 0) + 1;
  return global.a;
}

test('Global state is isolated and maintained between activations', async (t) => {
  const { createWorker, taskQueue, env } = t.context;
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const res1 = await env.client.workflow.execute(globalMutator, { taskQueue, workflowId: randomUUID() });
    const res2 = await env.client.workflow.execute(globalMutator, { taskQueue, workflowId: randomUUID() });
    t.is(res1, 2);
    t.is(res2, 2);
  });
});

export async function propertyMutator(): Promise<void> {
  try {
    (arrayFromPayloads as any).a = 1;
  } catch (err) {
    throw ApplicationFailure.fromError(err);
  }
}

test('Module state is frozen', async (t) => {
  const { createWorker, taskQueue, env } = t.context;
  const worker = await createWorker();
  const err = (await worker.runUntil(
    t.throwsAsync(env.client.workflow.execute(propertyMutator, { taskQueue, workflowId: randomUUID() }))
  )) as WorkflowFailedError;
  t.is(err.cause?.message, 'Cannot add property a, object is not extensible');
});

export async function sharedGlobalMutator(): Promise<void> {
  try {
    (setTimeout as any).a = 1;
  } catch (err) {
    throw ApplicationFailure.fromError(err);
  }
}

test('Shared global state is frozen', async (t) => {
  const { createWorker, taskQueue, env } = t.context;
  const worker = await createWorker();
  const err = (await worker.runUntil(
    t.throwsAsync(env.client.workflow.execute(sharedGlobalMutator, { taskQueue, workflowId: randomUUID() }))
  )) as WorkflowFailedError;
  t.is(err.cause?.message, 'Cannot add property a, object is not extensible');
});
