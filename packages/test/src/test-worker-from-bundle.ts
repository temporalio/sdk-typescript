/**
 * Test the various states of a Worker.
 * Most tests use a mocked core, some tests run serially because they emit signals to the process
 */
import test from 'ava';
import { join as pathJoin } from 'path';
import { unlink, writeFile } from 'fs/promises';
import os from 'os';
import { v4 as uuid4 } from 'uuid';
import { WorkflowClient } from '@temporalio/client';
import { bundleWorkflowCode, DefaultLogger, LogEntry, Worker } from '@temporalio/worker';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { successString } from './workflows';
import { issue516 } from './mocks/workflows-with-node-dependencies/issue-516';

if (RUN_INTEGRATION_TESTS) {
  test('Worker can be created from bundle code', async (t) => {
    const taskQueue = `${t.title}-${uuid4()}`;
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows'),
    });
    const worker = await Worker.create({
      taskQueue,
      workflowBundle,
    });
    const client = new WorkflowClient();
    await Promise.all([
      worker.run(),
      (async () => {
        try {
          await client.execute(successString, { taskQueue, workflowId: uuid4() });
        } finally {
          worker.shutdown();
        }
      })(),
    ]);
    t.pass();
  });

  test('Worker can be created from bundle path', async (t) => {
    const taskQueue = `${t.title}-${uuid4()}`;
    const { code } = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows'),
    });
    const path = pathJoin(os.tmpdir(), `workflow-bundle-${uuid4()}`);
    await writeFile(path, code);
    const workflowBundle = { path };
    const worker = await Worker.create({
      taskQueue,
      workflowBundle,
    });
    const client = new WorkflowClient();
    try {
      await Promise.all([
        worker.run(),
        (async () => {
          try {
            client.execute(successString, { taskQueue, workflowId: uuid4() });
          } finally {
            worker.shutdown();
          }
        })(),
      ]);
    } finally {
      unlink(path);
    }
    t.pass();
  });

  test('Workflow bundle can be created from code using ignoreModules', async (t) => {
    const taskQueue = `${t.title}-${uuid4()}`;
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./mocks/workflows-with-node-dependencies/issue-516'),
      ignoreModules: ['dns'],
    });
    const worker = await Worker.create({
      taskQueue,
      workflowBundle,
    });
    const client = new WorkflowClient();
    await Promise.all([
      worker.run(),
      (async () => {
        try {
          await client.execute(issue516, { taskQueue, workflowId: uuid4() });
        } finally {
          worker.shutdown();
        }
      })(),
    ]);
    t.pass();
  });

  test('A warning is reported when workflow depends on a node built-in module', async (t) => {
    const logs: LogEntry[] = [];
    const logger = new DefaultLogger('WARN', (entry: LogEntry) => {
      logs.push(entry);
      console.warn(entry.message);
    });

    await bundleWorkflowCode({
      workflowsPath: require.resolve('./mocks/workflows-with-node-dependencies/issue-516'),
      logger,
    });

    t.true(
      logs.some(
        (entry) => entry.message.match(/'dns'/) && entry.message.match(/'WorkerOptions.bundlerOptions.ignoreModules'/)
      ),
      "Bundler reported a warning message about package 'dns'"
    );
  });
}
