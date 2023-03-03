/**
 * Test the various states of a Worker.
 * Most tests use a mocked core, some tests run serially because they emit signals to the process
 */
import { unlink, writeFile } from 'fs/promises';
import os from 'os';
import { join as pathJoin } from 'path';
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { moduleMatches } from '@temporalio/worker/lib/workflow/bundler';
import { bundleWorkflowCode, DefaultLogger, LogEntry } from '@temporalio/worker';
import { WorkflowClient } from '@temporalio/client';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { issue516 } from './mocks/workflows-with-node-dependencies/issue-516';
import { successString } from './workflows';

test('moduleMatches works', (t) => {
  t.true(moduleMatches('fs', ['fs']));
  t.true(moduleMatches('fs/lib/foo', ['fs']));
  t.false(moduleMatches('fs', ['foo']));
});

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
    await worker.runUntil(client.execute(successString, { taskQueue, workflowId: uuid4() }));
    t.pass();
  });

  test('Worker can be created from bundle path', async (t) => {
    const taskQueue = `${t.title}-${uuid4()}`;
    const { code } = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows'),
    });
    const uid = uuid4();
    const codePath = pathJoin(os.tmpdir(), `workflow-bundle-${uid}.js`);
    await writeFile(codePath, code);
    const workflowBundle = { codePath };
    const worker = await Worker.create({
      taskQueue,
      workflowBundle,
    });
    const client = new WorkflowClient();
    try {
      await worker.runUntil(client.execute(successString, { taskQueue, workflowId: uuid4() }));
    } finally {
      await unlink(codePath);
    }
    t.pass();
  });

  test('Workflow bundle can be created from code using ignoreModules', async (t) => {
    const taskQueue = `${t.title}-${uuid4()}`;
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./mocks/workflows-with-node-dependencies/issue-516'),
      ignoreModules: ['dns', 'http'],
    });
    const worker = await Worker.create({
      taskQueue,
      workflowBundle,
    });
    const client = new WorkflowClient();
    await worker.runUntil(client.execute(issue516, { taskQueue, workflowId: uuid4() }));
    t.pass();
  });

  test('An error is thrown when workflow depends on a node built-in module', async (t) => {
    const logs: LogEntry[] = [];
    const logger = new DefaultLogger('WARN', (entry: LogEntry) => {
      logs.push(entry);
      console.warn(entry.message);
    });

    await t.throwsAsync(
      bundleWorkflowCode({
        workflowsPath: require.resolve('./mocks/workflows-with-node-dependencies/issue-516'),
        logger,
      }),
      {
        instanceOf: Error,
        message: /is importing the following disallowed modules.*dns/s,
      }
    );
  });

  test('WorkerOptions.bundlerOptions.webpackConfigHook works', async (t) => {
    const taskQueue = `${t.title}-${uuid4()}`;
    await t.throwsAsync(
      Worker.create({
        taskQueue,
        workflowsPath: require.resolve('./workflows'),
        bundlerOptions: {
          webpackConfigHook: (config) => {
            t.is(config.mode, 'development');
            config.mode = 'invalid' as any;
            return config;
          },
        },
      }),
      {
        name: 'ValidationError',
        message: /Invalid configuration object./,
      }
    );
  });
}
