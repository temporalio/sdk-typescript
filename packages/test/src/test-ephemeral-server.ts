import fs from 'fs/promises';
import anyTest, { ExecutionContext, TestFn } from 'ava';
import { v4 as uuid4 } from 'uuid';
import { bundleWorkflowCode, WorkflowBundle } from '@temporalio/worker';
import { Worker, TestWorkflowEnvironment, testTimeSkipping as anyTestTimeSkipping } from './helpers';

interface Context {
  bundle: WorkflowBundle;
  taskQueue: string;
}

const test = anyTest as TestFn<Context>;
const testTimeSkipping = anyTestTimeSkipping as TestFn<Context>;

test.before(async (t) => {
  t.context.bundle = await bundleWorkflowCode({ workflowsPath: require.resolve('./workflows') });
});

test.beforeEach(async (t) => {
  t.context.taskQueue = t.title.replace(/ /g, '_');
});

async function runSimpleWorkflow(t: ExecutionContext<Context>, testEnv: TestWorkflowEnvironment) {
  try {
    const { taskQueue } = t.context;
    const { client, nativeConnection, namespace } = testEnv;
    const worker = await Worker.create({
      connection: nativeConnection,
      namespace,
      taskQueue,
      workflowBundle: t.context.bundle,
    });
    await worker.runUntil(
      client.workflow.execute('successString', {
        workflowId: uuid4(),
        taskQueue,
      })
    );
  } finally {
    await testEnv.teardown();
  }
  t.pass();
}

testTimeSkipping('TestEnvironment sets up test server and is able to run a single workflow', async (t) => {
  const testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  await runSimpleWorkflow(t, testEnv);
});

test('TestEnvironment sets up dev server and is able to run a single workflow', async (t) => {
  const testEnv = await TestWorkflowEnvironment.createLocal();
  await runSimpleWorkflow(t, testEnv);
});

test.todo('TestEnvironment sets up test server with extra args');
test.todo('TestEnvironment sets up test server with specified port');
test.todo('TestEnvironment sets up test server with latest version');
test.todo('TestEnvironment sets up test server from executable path');

test.todo('TestEnvironment sets up dev server with extra args');
test.todo('TestEnvironment sets up dev server with latest version');
test.todo('TestEnvironment sets up dev server from executable path');
test.todo('TestEnvironment sets up dev server with custom log level');
test.todo('TestEnvironment sets up dev server with custom namespace, IP and UI');

test('TestEnvironment sets up dev server with db filename', async (t) => {
  const dbFilename = `temporal-db-${uuid4()}.sqlite`;
  try {
    const testEnv = await TestWorkflowEnvironment.createLocal({
      server: {
        dbFilename,
      },
    });
    t.truthy(await fs.stat(dbFilename).catch(() => false), 'DB file exists');
    await testEnv.teardown();
  } finally {
    await fs.unlink(dbFilename).catch(() => {
      /* ignore errors */
    });
  }
});
