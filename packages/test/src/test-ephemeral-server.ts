import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import type { ExecutionContext, TestFn } from 'ava';
import anyTest from 'ava';
import type { WorkflowBundle } from '@temporalio/worker';
import { bundleWorkflowCode } from '@temporalio/worker';
import { Connection } from '@temporalio/client';
import { TestWorkflowEnvironment as RealTestWorkflowEnvironment } from '@temporalio/testing';
import {
  Worker,
  TestWorkflowEnvironment,
  testTimeSkipping as testTimeSkippingFromHelpers,
  getRandomPort,
  isBun,
} from './helpers';

interface Context {
  bundle: WorkflowBundle;
  taskQueue: string;
}

const test = anyTest as TestFn<Context>;
const testTimeSkipping = testTimeSkippingFromHelpers as TestFn<Context>;

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
        workflowId: randomUUID(),
        taskQueue,
      })
    );
  } finally {
    await testEnv.teardown();
  }
  t.pass();
}

// The dev server's gRPC frontend and its Web UI start as independent listeners.
// createLocal() only waits for the gRPC frontend to become reachable (see the
// readiness loop in sdk-core's ephemeral_server), so the UI's HTTP server may not
// be accepting connections yet when the call resolves. Until it is, fetch() rejects
// with a connection-refused error (Node: `TypeError: fetch failed` with
// `cause.code === 'ECONNREFUSED'`; Bun: `Error` with `code === 'ConnectionRefused'`).
//
// A resolved fetch() only means the socket connected and some response came back, so
// we additionally require a 2xx status: that confirms the UI is actually serving, not
// merely listening. Poll until that holds, or fail after a bounded timeout.
async function fetchUntilReady(url: string, timeoutMs = 10_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastError = new Error(`${url} responded with HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${url} to become ready after ${timeoutMs}ms (last error: ${lastError})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
  const dbFilename = `temporal-db-${randomUUID()}.sqlite`;
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

// Something with the Bun implementation of `node:net` on Windows results in
// parallel calls to `getRandomPort` resulting in the same port.
const testMaybeSerial = isBun && process.platform === 'win32' ? test.serial : test;

testMaybeSerial('TestEnvironment sets up dev server with custom port and ui', async (t) => {
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
      connectTimeout: 5000,
    });
    await connection.ensureConnected();

    // With UI enabled but no ui port specified, the UI should be listening on port + 1000.
    await fetchUntilReady(`http://127.0.0.1:${port + 1000}/namespaces`);

    t.pass();
  } finally {
    await testEnv.teardown();
  }
});

testMaybeSerial('TestEnvironment sets up dev server with custom ui port', async (t) => {
  const port = await getRandomPort();
  const testEnv = await RealTestWorkflowEnvironment.createLocal({
    server: {
      uiPort: port,
    },
  });
  try {
    await fetchUntilReady(`http://127.0.0.1:${port}/namespaces`);
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
