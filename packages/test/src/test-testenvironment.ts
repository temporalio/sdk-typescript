import anyTest, { TestInterface } from 'ava';
import { v4 as uuid4 } from 'uuid';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { defaultOptions } from './mock-native-worker';
import { sleeper } from './workflows';

interface Context {
  testEnv: TestWorkflowEnvironment;
}

const test = anyTest as TestInterface<Context>;

test.before(async (t) => {
  t.context = {
    testEnv: await TestWorkflowEnvironment.create(),
  };
});

test.after.always(async (t) => {
  await t.context.testEnv?.teardown();
});

test('TestEnvironment sets up test server and is able to run a Workflow with time skipping', async (t) => {
  const worker = await Worker.create(defaultOptions);
  const client = t.context.testEnv.workflowClient;
  const runAndShutdown = async () => {
    try {
      await client.execute(sleeper, {
        workflowId: uuid4(),
        taskQueue: 'test',
        args: [1_000_000],
      });
    } finally {
      worker.shutdown();
    }
  };
  await Promise.all([worker.run(), runAndShutdown()]);
  t.pass();
});
