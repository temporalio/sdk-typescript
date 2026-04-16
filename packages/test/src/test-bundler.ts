/**
 * Test the various states of a Worker.
 * Most tests use a mocked core, some tests run serially because they emit signals to the process
 */
import { unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join as pathJoin } from 'node:path';
import test, { ExecutionContext } from 'ava';
import { v4 as uuid4 } from 'uuid';
import { moduleMatches } from '@temporalio/worker/lib/workflow/bundler';
import { bundleWorkflowCode, DefaultLogger, LogEntry, WorkerOptions } from '@temporalio/worker';
import { WorkflowClient } from '@temporalio/client';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { issue516 } from './mocks/workflows-with-node-dependencies/issue-516';
import { preloadSharedCounter } from './workflows/preload-shared-counter';
import { successString } from './workflows';

test('moduleMatches works', (t) => {
  t.true(moduleMatches('fs', ['fs']));
  t.true(moduleMatches('fs/lib/foo', ['fs']));
  t.false(moduleMatches('fs', ['foo']));
});

async function runPreloadSharedCounter(
  t: ExecutionContext,
  workerOptions: Pick<WorkerOptions, 'bundlerOptions' | 'workflowBundle' | 'workflowsPath'>
): Promise<[number, number]> {
  const taskQueue = `${t.title}-${uuid4()}`;
  const client = new WorkflowClient();
  const worker = await Worker.create({
    taskQueue,
    reuseV8Context: true,
    ...workerOptions,
  });
  return await worker.runUntil(async () => {
    const first = await client.execute(preloadSharedCounter, { taskQueue, workflowId: uuid4() });
    const second = await client.execute(preloadSharedCounter, { taskQueue, workflowId: uuid4() });
    return [first, second];
  });
}

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
      ignoreModules: ['dns'],
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

  test('Workflow bundle can preload modules into the reusable V8 context', async (t) => {
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/preload-shared-counter'),
      preloadModules: [require.resolve('./workflows/preload-shared-counter-helper')],
    });

    t.deepEqual(await runPreloadSharedCounter(t, { workflowBundle }), [1, 2]);
  });

  test('Workflow bundle keeps module state isolated without preloadModules', async (t) => {
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/preload-shared-counter'),
    });

    t.deepEqual(await runPreloadSharedCounter(t, { workflowBundle }), [1, 1]);
  });

  test('Workflow bundle treats an empty preloadModules list as a no-op', async (t) => {
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/preload-shared-counter'),
      preloadModules: [],
    });

    t.deepEqual(await runPreloadSharedCounter(t, { workflowBundle }), [1, 1]);
  });

  test('WorkerOptions.bundlerOptions.preloadModules works', async (t) => {
    t.deepEqual(
      await runPreloadSharedCounter(t, {
        workflowsPath: require.resolve('./workflows/preload-shared-counter'),
        bundlerOptions: {
          preloadModules: [require.resolve('./workflows/preload-shared-counter-helper')],
        },
      }),
      [1, 2]
    );
  });

  test('An error is thrown when a preloaded module is also ignored', async (t) => {
    const helperModule = require.resolve('./workflows/preload-shared-counter-helper');

    await t.throwsAsync(
      bundleWorkflowCode({
        workflowsPath: require.resolve('./workflows/preload-shared-counter'),
        ignoreModules: [helperModule],
        preloadModules: [helperModule],
      }),
      {
        instanceOf: Error,
        message: /Cannot preload modules that are also ignored: .*preload-shared-counter-helper/,
      }
    );
  });

  // Regression test: workflow bundles must not include @temporalio/proto sources.
  test('Workflow bundle does not include @temporalio/proto sources and fits within size limit', async (t) => {
    const bundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/workflow-with-standard-api-usage'),
    });

    // The bundle has an inline source map appended as a single-line comment; separate them.
    const SOURCEMAP_LINE_PREFIX = '//# sourceMappingURL=data:application/json;charset=utf-8;base64,';
    const smLineStart = bundle.code.lastIndexOf('\n' + SOURCEMAP_LINE_PREFIX);
    t.not(smLineStart, -1, 'Bundle should contain an inline source map');
    const codeOnly = bundle.code.slice(0, smLineStart);
    const sourcemapBase64 = bundle.code.slice(smLineStart + 1 + SOURCEMAP_LINE_PREFIX.length).trimEnd();

    // Check code size (excluding inline source map).
    // As of April 2026, I get ~440 KB for the bundle excluding inlined source map.
    // Some increase is expected over time as we'll continue adding more features to the SDK, but
    // large sudden increases likely indicate we're importing in the bundle something we shouldn't.
    const codeSizeKB = Buffer.byteLength(codeOnly, 'utf-8') / 1024;
    t.log(`Bundle code size: ${codeSizeKB.toFixed(0)} KB`);
    t.true(
      codeSizeKB < 600,
      `Bundle code size (${codeSizeKB.toFixed(0)} KB) exceeds 600 KB — ` +
        `either @temporalio/proto was pulled in, or another unexpectedly large dependency was added`
    );

    // Parse the inline source map to enumerate bundled source files.
    const sourceMap: { sources: string[] } = JSON.parse(Buffer.from(sourcemapBase64, 'base64').toString('utf-8'));
    const sources = sourceMap.sources.slice().sort();

    // Log the full list for manual review (visible in verbose mode or on test failure).
    t.log(`\nSources included in bundle (${sources.length} files):`);
    for (const source of sources) {
      t.log(`  ${source}`);
    }

    // Ensure there is no trace of @temporalio/proto in the bundle.
    const protoSources = sources.filter((s) => s.includes('/packages/proto/') || s.includes('@temporalio/proto'));
    t.deepEqual(protoSources, [], `@temporalio/proto must not appear in workflow bundle sources.}`);
  });
}
