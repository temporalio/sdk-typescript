import { randomUUID } from 'crypto';
import { TestFn } from 'ava';
import { WorkflowFailedError } from '@temporalio/client';
import { bundleWorkflowCode, WorkflowBundle } from '@temporalio/worker';
import { test as anyTest, bundlerOptions, Worker, TestWorkflowEnvironment } from './helpers';
import type { TestBatchResult, FlakyTest } from './ci/types';
import { testSuiteWorkflow } from './ci/workflows';

interface Context {
  env: TestWorkflowEnvironment;
  workflowBundle: WorkflowBundle;
}

const test = anyTest as TestFn<Context>;

test.before(async (t) => {
  t.context = {
    env: await TestWorkflowEnvironment.createLocal(),
    workflowBundle: await bundleWorkflowCode({
      workflowsPath: require.resolve('./ci/workflows'),
      ...bundlerOptions,
    }),
  };
});

test.after.always(async (t) => {
  await t.context.env?.teardown();
});

test.serial('all pass on first attempt', async (t) => {
  const taskQueue = `test-ci-${randomUUID()}`;
  const worker = await Worker.create({
    connection: t.context.env.nativeConnection,
    workflowBundle: t.context.workflowBundle,
    taskQueue,
    activities: {
      async discoverTests() {
        return ['lib/test-a.js', 'lib/test-b.js'];
      },
      async runTests(): Promise<TestBatchResult> {
        return { passed: ['lib/test-a.js', 'lib/test-b.js'], failed: [], failureDetails: {} };
      },
      async alertFlakes() {},
    },
  });

  const result = await worker.runUntil(
    t.context.env.client.workflow.execute(testSuiteWorkflow, {
      workflowId: randomUUID(),
      taskQueue,
      args: [{}],
    })
  );

  t.is(result.totalFiles, 2);
  t.is(result.passed.length, 2);
  t.is(result.failed.length, 0);
  t.is(result.flakes.length, 0);
  t.is(result.retriesUsed, 0);
});

test.serial('retries failed files and detects flakes', async (t) => {
  let attempt = 0;
  const taskQueue = `test-ci-${randomUUID()}`;
  const worker = await Worker.create({
    connection: t.context.env.nativeConnection,
    workflowBundle: t.context.workflowBundle,
    taskQueue,
    activities: {
      async discoverTests() {
        return ['lib/test-a.js', 'lib/test-b.js'];
      },
      async runTests(files: string[]): Promise<TestBatchResult> {
        attempt++;
        if (attempt === 1) {
          return {
            passed: ['lib/test-a.js'],
            failed: ['lib/test-b.js'],
            failureDetails: { 'lib/test-b.js': ['flaky assertion'] },
          };
        }
        // Second attempt: test-b passes
        return { passed: files, failed: [], failureDetails: {} };
      },
      async alertFlakes(flakes: FlakyTest[]) {
        t.is(flakes.length, 1);
        t.is(flakes[0].file, 'lib/test-b.js');
        t.is(flakes[0].attemptsToPass, 2);
      },
    },
  });

  const result = await worker.runUntil(
    t.context.env.client.workflow.execute(testSuiteWorkflow, {
      workflowId: randomUUID(),
      taskQueue,
      args: [{}],
    })
  );

  t.is(result.totalFiles, 2);
  t.is(result.passed.length, 2);
  t.is(result.failed.length, 0);
  t.is(result.flakes.length, 1);
  t.is(result.retriesUsed, 1);
});

test.serial('fails after exhausting retries', async (t) => {
  const taskQueue = `test-ci-${randomUUID()}`;
  const worker = await Worker.create({
    connection: t.context.env.nativeConnection,
    workflowBundle: t.context.workflowBundle,
    taskQueue,
    activities: {
      async discoverTests() {
        return ['lib/test-a.js'];
      },
      async runTests(): Promise<TestBatchResult> {
        return {
          passed: [],
          failed: ['lib/test-a.js'],
          failureDetails: { 'lib/test-a.js': ['always fails'] },
        };
      },
      async alertFlakes() {},
    },
  });

  const err = await t.throwsAsync(
    worker.runUntil(
      t.context.env.client.workflow.execute(testSuiteWorkflow, {
        workflowId: randomUUID(),
        taskQueue,
        args: [{ maxRetries: 1 }],
      })
    ),
    { instanceOf: WorkflowFailedError }
  );
  t.truthy(err);
  t.truthy(err!.message.includes('lib/test-a.js') || err!.cause?.message.includes('lib/test-a.js'));
});

test.serial('uses provided file list instead of discovery', async (t) => {
  let discoveredCalled = false;
  const taskQueue = `test-ci-${randomUUID()}`;
  const worker = await Worker.create({
    connection: t.context.env.nativeConnection,
    workflowBundle: t.context.workflowBundle,
    taskQueue,
    activities: {
      async discoverTests() {
        discoveredCalled = true;
        return [];
      },
      async runTests(files: string[]): Promise<TestBatchResult> {
        return { passed: files, failed: [], failureDetails: {} };
      },
      async alertFlakes() {},
    },
  });

  const result = await worker.runUntil(
    t.context.env.client.workflow.execute(testSuiteWorkflow, {
      workflowId: randomUUID(),
      taskQueue,
      args: [{ files: ['lib/test-specific.js'] }],
    })
  );

  t.false(discoveredCalled);
  t.deepEqual(result.passed, ['lib/test-specific.js']);
});
