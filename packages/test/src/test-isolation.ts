import { randomUUID } from 'crypto';
import { TestFn, ImplementationFn } from 'ava';
import { ApplicationFailure, arrayFromPayloads } from '@temporalio/common';
import { bundleWorkflowCode, WorkflowBundle } from '@temporalio/worker';
import { sleep, workflowInfo } from '@temporalio/workflow';
import { WorkflowFailedError } from '@temporalio/client';
import { test as anyTest, bundlerOptions, Worker, REUSE_V8_CONTEXT, TestWorkflowEnvironment } from './helpers';

interface Context {
  env: TestWorkflowEnvironment;
  taskQueue: string;
  workflowBundle: WorkflowBundle;
  createWorker(): Promise<Worker>;
}

const test = anyTest as TestFn<Context>;

const withReusableContext = test.macro<[ImplementationFn<[], Context>]>(async (t, fn) => {
  if (!REUSE_V8_CONTEXT) {
    t.pass('Skipped since REUSE_V8_CONTEXT is set to false');
    return;
  }
  await fn(t);
});

test.before(async (t) => {
  t.context.env = await TestWorkflowEnvironment.createLocal();
  t.context.workflowBundle = await bundleWorkflowCode({ workflowsPath: __filename, ...bundlerOptions });
});

test.beforeEach(async (t) => {
  t.context.taskQueue = t.title.replace(/ /g, '_');
  t.context.createWorker = async () => {
    const { env, workflowBundle, taskQueue } = t.context;
    return await Worker.create({
      connection: env.nativeConnection,
      workflowBundle,
      taskQueue,
    });
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

export async function sdkPropertyMutator(): Promise<void> {
  try {
    (arrayFromPayloads as any).a = 1;
  } catch (err) {
    throw ApplicationFailure.fromError(err);
  }
}

test('SDK Module state is frozen', withReusableContext, async (t) => {
  const { createWorker, taskQueue, env } = t.context;
  const worker = await createWorker();
  const err = (await worker.runUntil(
    t.throwsAsync(env.client.workflow.execute(sdkPropertyMutator, { taskQueue, workflowId: randomUUID() }))
  )) as WorkflowFailedError;
  t.is(err.cause?.message, 'Cannot add property a, object is not extensible');
});

const someArr: number[] = [];

export async function modulePropertyMutator(): Promise<number[]> {
  someArr.push(1);
  await sleep(1);
  someArr.push(2);
  return someArr;
}

test('Module state is isolated and maintained between activations', async (t) => {
  const { createWorker, taskQueue, env } = t.context;
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const [res1, res2] = await Promise.all([
      env.client.workflow.execute(modulePropertyMutator, { taskQueue, workflowId: randomUUID() }),
      env.client.workflow.execute(modulePropertyMutator, { taskQueue, workflowId: randomUUID() }),
    ]);
    t.deepEqual(res1, [1, 2]);
    t.deepEqual(res2, [1, 2]);
  });
});

const someMap: Map<string, number> = new Map();

export async function moduleMapMutator(): Promise<[number, number]> {
  someMap.set('test', (someMap.get('test') || 0) + 1);
  const middle = someMap.get('test') as number;
  await sleep(1);
  someMap.set('test', (someMap.get('test') || 0) + 1);
  const final = someMap.get('test') as number;
  return [middle, final];
}

test('Deep Freeze reaches Map values', async (t) => {
  const { createWorker, taskQueue, env } = t.context;
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const [res1, res2] = await Promise.all([
      env.client.workflow.execute(moduleMapMutator, { taskQueue, workflowId: randomUUID() }),
      env.client.workflow.execute(moduleMapMutator, { taskQueue, workflowId: randomUUID() }),
    ]);
    t.deepEqual(res1, [1, 2]);
    t.deepEqual(res2, [1, 2]);
  });
});

export async function sharedGlobalMutator(): Promise<void> {
  try {
    (Array as any).a = 1;
  } catch (err) {
    throw ApplicationFailure.fromError(err);
  }
}

test('Shared global state is frozen', withReusableContext, async (t) => {
  const { createWorker, taskQueue, env } = t.context;
  const worker = await createWorker();
  const err = (await worker.runUntil(
    t.throwsAsync(env.client.workflow.execute(sharedGlobalMutator, { taskQueue, workflowId: randomUUID() }))
  )) as WorkflowFailedError;
  t.is(err.cause?.message, 'Cannot add property a, object is not extensible');
});

export async function sharedGlobalReassignment(): Promise<[string, string, string]> {
  type ConsoleExtended = Console & { wfid: string };
  // Replace the `console` global by a new object
  globalThis.console = { ...globalThis.console, wfid: workflowInfo().workflowId } as ConsoleExtended;
  const middle = (globalThis.console as ConsoleExtended).wfid;
  await sleep(50);
  return [workflowInfo().workflowId, middle, (globalThis.console as ConsoleExtended).wfid];
}

test('Reassign shared global state', withReusableContext, async (t) => {
  const { createWorker, taskQueue, env } = t.context;
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const [res1, res2] = await Promise.all([
      env.client.workflow.execute(sharedGlobalReassignment, { taskQueue, workflowId: randomUUID() }),
      env.client.workflow.execute(sharedGlobalReassignment, { taskQueue, workflowId: randomUUID() }),
    ]);
    t.deepEqual(res1[0], res1[1]);
    t.deepEqual(res1[0], res1[2]);
    t.deepEqual(res2[0], res2[1]);
    t.deepEqual(res2[0], res2[2]);
  });
});

export async function globalMutatorAndDestructor(): Promise<number> {
  const global = globalThis as { a?: number };
  global.a = (global.a || 0) + 1;
  await sleep(1);
  delete global.a;
  await sleep(1);
  global.a = (global.a || 0) + 1;
  return global.a;
}

test('Set then Delete a global property', withReusableContext, async (t) => {
  const { createWorker, taskQueue, env } = t.context;
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const res = await env.client.workflow.execute(globalMutatorAndDestructor, { taskQueue, workflowId: randomUUID() });
    t.is(res, 1);
  });
});
