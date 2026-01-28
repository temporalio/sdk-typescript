import * as process from 'process';
import { TestFn } from 'ava';
import { v4 as uuid4 } from 'uuid';
import { WorkflowFailedError } from '@temporalio/client';
import { bundleWorkflowCode, WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { workflowInterceptorModules } from '@temporalio/testing';
import { Worker, TestWorkflowEnvironment, testTimeSkipping } from './helpers';
import {
  assertFromWorkflow,
  asyncChildStarter,
  raceActivityAndTimer,
  sleep,
  unblockSignal,
  waitOnSignalWithTimeout,
} from './workflows/testenv-test-workflows';

interface Context {
  testEnv: TestWorkflowEnvironment;
  bundle: WorkflowBundleWithSourceMap;
}

const test_ = testTimeSkipping as TestFn<Context>;

test_.before(async (t) => {
  t.context = {
    testEnv: await TestWorkflowEnvironment.createTimeSkipping(),
    bundle: await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/testenv-test-workflows'),
      workflowInterceptorModules,
    }),
  };
});

test_.after.always(async (t) => {
  await t.context.testEnv?.teardown();
});

test_.serial('TestEnvironment sets up test server and is able to run a Workflow with time skipping', async (t) => {
  const { client, nativeConnection } = t.context.testEnv;
  const worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: 'test',
    workflowBundle: t.context.bundle,
  });
  await worker.runUntil(
    client.workflow.execute(sleep, {
      workflowId: uuid4(),
      taskQueue: 'test',
      args: [1_000_000],
    })
  );
  t.pass();
});

test_.serial('TestEnvironment can toggle between normal and skipped time', async (t) => {
  const { client, nativeConnection } = t.context.testEnv;

  const worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: 'test',
    workflowBundle: t.context.bundle,
  });

  await worker.runUntil(async () => {
    const wfSleepDuration = 1_000_000;

    const t0 = process.hrtime.bigint();
    await client.workflow.execute(sleep, {
      workflowId: uuid4(),
      taskQueue: 'test',
      args: [wfSleepDuration],
    });
    const realDuration = Number((process.hrtime.bigint() - t0) / 1_000_000n);
    if (wfSleepDuration < realDuration) {
      t.fail(`Workflow execution took ${realDuration}, sleep duration was: ${wfSleepDuration}`);
    }
  });
  t.pass();
});

test_.serial('TestEnvironment sleep can be used to delay activity completion', async (t) => {
  const { client, nativeConnection, sleep } = t.context.testEnv;

  const worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: 'test',
    activities: {
      async sleep(duration: number) {
        await sleep(duration);
      },
    },
    workflowBundle: t.context.bundle,
  });

  const run = async (expectedWinner: 'timer' | 'activity') => {
    const winner = await client.workflow.execute(raceActivityAndTimer, {
      workflowId: uuid4(),
      taskQueue: 'test',
      args: [expectedWinner],
    });
    t.is(winner, expectedWinner);
  };
  await worker.runUntil(async () => {
    await run('activity');
    await run('timer');
  });
  t.pass();
});

test_.serial('TestEnvironment sleep can be used to delay sending a signal', async (t) => {
  const { client, nativeConnection, sleep } = t.context.testEnv;

  const worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: 'test',
    workflowBundle: t.context.bundle,
  });

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(waitOnSignalWithTimeout, {
      workflowId: uuid4(),
      taskQueue: 'test',
    });
    await sleep(1_000_000); // Time is skipped
    await handle.signal(unblockSignal);
    await handle.result(); // Time is skipped
  });
  t.pass();
});

test_.serial('Workflow code can run assertions', async (t) => {
  const { client, nativeConnection } = t.context.testEnv;

  const worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: 'test',
    workflowBundle: t.context.bundle,
  });

  const err: WorkflowFailedError | undefined = await t.throwsAsync(
    worker.runUntil(
      client.workflow.execute(assertFromWorkflow, {
        workflowId: uuid4(),
        taskQueue: 'test',
        args: [6],
      })
    ),
    { instanceOf: WorkflowFailedError }
  );
  t.is(err?.cause?.message, 'Expected values to be strictly equal:\n\n6 !== 7\n');
});

test_.serial('ABNADONED child timer can be fast-forwarded', async (t) => {
  const { client, nativeConnection } = t.context.testEnv;

  const worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: 'test',
    workflowBundle: t.context.bundle,
  });

  const childWorkflowId = uuid4();
  await worker.runUntil(async () => {
    await client.workflow.execute(asyncChildStarter, {
      workflowId: uuid4(),
      taskQueue: 'test',
      args: [childWorkflowId],
    });
    await client.workflow.getHandle(childWorkflowId).result();
  });

  t.pass();
});
