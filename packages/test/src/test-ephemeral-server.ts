import fs from 'fs/promises';
import anyTest, { ExecutionContext, TestFn } from 'ava';
import { v4 as uuid4 } from 'uuid';
import { bundleWorkflowCode, WorkflowBundle } from '@temporalio/worker';
import { Connection } from '@temporalio/client';
import { TestWorkflowEnvironment as RealTestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, TestWorkflowEnvironment, testTimeSkipping as anyTestTimeSkipping, getRandomPort } from './helpers';

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

test('TestEnvironment sets up dev server with custom port and ui', async (t) => {
  // FIXME: We'd really need to assert that the UI port is not being used by another process.
  let port = await getRandomPort();
  if (port > 65535 - 1000) port = 65535 - 1000;

  const testEnv = await TestWorkflowEnvironment.createLocal({
    server: {
      ip: '127.0.0.1',
      port,
      ui: true,
    },
  });

  try {
    // Check that we can connect to the server using the connection provided by the testEnv.
    await testEnv.connection.ensureConnected();

    // Check that we can connect to the server _on the expected port_.
    const connection = await Connection.connect({
      address: `127.0.0.1:${port}`,
      connectTimeout: 500,
    });
    await connection.ensureConnected();

    // With UI enabled but no ui port specified, the UI should be listening on port + 1000.
    await fetch(`http://127.0.0.1:${port + 1000}/namespaces`);

    t.pass();
  } finally {
    await testEnv.teardown();
  }
});

test('TestEnvironment sets up dev server with custom ui port', async (t) => {
  const port = await getRandomPort();
  const testEnv = await RealTestWorkflowEnvironment.createLocal({
    server: {
      uiPort: port,
    },
  });
  try {
    await fetch(`http://127.0.0.1:${port}/namespaces`);
    t.pass();
  } finally {
    await testEnv.teardown();
  }
});

test("TestEnvironment doesn't hang on fail to download", async (t) => {
  try {
    // Our internal TestWorkflowEnvironment helper may override the executable version
    // if TESTS_CLI_VERSION is set, which would cause this test to fail. To avoid that,
    // we use the RealTestWorkflowEnvironment directly.
    await RealTestWorkflowEnvironment.createLocal({
      server: {
        executable: {
          type: 'cached-download',
          version: '999.999.999',
        },
      },
    });
  } catch (_e) {
    t.pass();
  }
});

test('TestEnvironment.createLocal correctly populates address', async (t) => {
  const testEnv = await RealTestWorkflowEnvironment.createLocal();
  t.teardown(() => testEnv.teardown());
  await t.notThrowsAsync(async () => {
    await Connection.connect({
      address: testEnv.address,
      connectTimeout: 5000,
    });
  }, 'should be able to connect to test server');
});
