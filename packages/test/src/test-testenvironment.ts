import anyTest, { TestInterface } from 'ava';
import { v4 as uuid4 } from 'uuid';
import { WorkflowFailedError } from '@temporalio/client';
import { TestWorkflowEnvironment, workflowInterceptorModules } from '@temporalio/testing';
import { Connection } from '@temporalio/testing/lib/connection';
import { Worker } from '@temporalio/worker';
import {
  assertFromWorkflow,
  raceActivityAndTimer,
  sleep,
  unblockSignal,
  waitOnSignalWithTimeout,
} from './workflows/testenv-test-workflows';

interface Context {
  testEnv: TestWorkflowEnvironment;
}

const test = anyTest as TestInterface<Context>;

test.before(async (t) => {
  t.context = {
    testEnv: await TestWorkflowEnvironment.createTimeSkipping(),
  };
});

test.after.always(async (t) => {
  await t.context.testEnv?.teardown();
});

test.serial('TestEnvironment sets up test server and is able to run a Workflow with time skipping', async (t) => {
  const { client, nativeConnection } = t.context.testEnv;
  const worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: 'test',
    workflowsPath: require.resolve('./workflows/testenv-test-workflows'),
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

test.serial('TestEnvironment can toggle between normal and skipped time', async (t) => {
  const { client, nativeConnection } = t.context.testEnv;

  const worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: 'test',
    workflowsPath: require.resolve('./workflows/testenv-test-workflows'),
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

test.serial('TestEnvironment sleep can be used to delay activity completion', async (t) => {
  // TODO: check why this fails on windows
  if (process.platform === 'win32') {
    t.pass();
    return;
  }
  const { client, nativeConnection, sleep } = t.context.testEnv;

  const worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: 'test',
    activities: {
      async sleep(duration: number) {
        await sleep(duration);
      },
    },
    workflowsPath: require.resolve('./workflows/testenv-test-workflows'),
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
    // TODO: there's an issue with the Java test server where if an activity
    // does not complete before its scheduling workflow, time skipping stays
    // locked.
    // If the order of the below 2 statements is reversed, this test will hang.
    await run('activity');
    await run('timer');
  });
  t.pass();
});

test.serial('TestEnvironment sleep can be used to delay sending a signal', async (t) => {
  // TODO: check why this fails on windows
  if (process.platform === 'win32') {
    t.pass();
    return;
  }
  const { client, nativeConnection, sleep } = t.context.testEnv;
  // TODO: due to the test server issue mentioned in the test avove we need to manually unlock time skipping
  // for the current test to balance out the time skipping lock counter.
  await (t.context.testEnv.connection as Connection).testService.unlockTimeSkipping({});

  const worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: 'test',
    workflowsPath: require.resolve('./workflows/testenv-test-workflows'),
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

test.serial('Workflow code can run assertions', async (t) => {
  const { client, nativeConnection } = t.context.testEnv;

  const worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: 'test',
    workflowsPath: require.resolve('./workflows/testenv-test-workflows'),
    interceptors: {
      workflowModules: workflowInterceptorModules,
    },
  });

  const err: WorkflowFailedError = await t.throwsAsync(
    worker.runUntil(
      client.workflow.execute(assertFromWorkflow, {
        workflowId: uuid4(),
        taskQueue: 'test',
        args: [6],
      })
    ),
    { instanceOf: WorkflowFailedError }
  );
  t.is(err.cause?.message, 'Expected values to be strictly equal:\n\n6 !== 7\n');
});
