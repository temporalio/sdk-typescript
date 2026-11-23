import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import asyncRetry from 'async-retry';
import type { ExecutionContext } from 'ava';
import { bundleWorkflowCode } from '@temporalio/worker';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import type { TestWorkflowEnvironment } from './helpers';
import { createTestWorkflowEnvironment, makeConfigurableEnvironmentTestFn } from './helpers-integration';

if (RUN_INTEGRATION_TESTS) {
  const test = makeConfigurableEnvironmentTestFn<{ env: TestWorkflowEnvironment }>({
    createTestContext: async () => ({ env: await createTestWorkflowEnvironment() }),
    teardown: async ({ env }) => env.teardown(),
  });

  async function fixture(t: ExecutionContext): Promise<string> {
    const directory = await mkdtemp(path.join(__dirname, 'execute-activity-'));
    t.teardown(() => rm(directory, { recursive: true, force: true }));
    await writeFile(
      path.join(directory, 'acts.ts'),
      `import fs from 'node:fs';
       throw new Error('ACTIVITY_MODULE_MUST_NOT_LOAD');
       export async function echo(value: string): Promise<string> { return fs.readFileSync(value, 'utf8'); }`
    );
    return directory;
  }

  for (const local of [false, true]) {
    for (const explicit of [false, true]) {
      test(`${local ? 'Local Activity' : 'Activity'} with ${explicit ? 'explicit factory' : 'inferred direct'} reference`, async (t) => {
        const directory = await fixture(t);
        const api = local ? 'executeLocalActivity' : 'executeActivity';
        const source = explicit
          ? `import { echo } from './acts' with { temporal: 'activity' };
             import { ${api} } from '@temporalio/workflow';
             const withTimeout = (activity: typeof echo) => (value: string) =>
               ${api}(activity, { args: [value], startToCloseTimeout: '1m' });
             export async function main() { return await withTimeout(echo)('hello'); }`
          : `import { echo as say } from './acts';
             import { ${api} as run } from '@temporalio/workflow';
             export async function main() { return await run(say, { args: ['hello'], startToCloseTimeout: '1m' }); }`;
        const workflowsPath = path.join(directory, 'workflow.ts');
        await writeFile(workflowsPath, source);
        const workflowBundle = await bundleWorkflowCode({ workflowsPath });
        t.false(workflowBundle.code.includes('ACTIVITY_MODULE_MUST_NOT_LOAD'));
        const taskQueue = randomUUID();
        const { env } = t.context;
        let attempts = 0;
        const worker = await Worker.create({
          connection: env.nativeConnection,
          namespace: env.client.options.namespace,
          taskQueue,
          workflowBundle,
          activities: {
            echo: async (value: string) => {
              if (++attempts === 1) throw new Error('retry once');
              return value;
            },
          },
        });
        await worker.runUntil(async () => {
          const handle = await env.client.workflow.start('main', { taskQueue, workflowId: randomUUID() });
          t.is(await handle.result(), 'hello');
          t.is(attempts, 2);
          const history = await handle.fetchHistory();
          await Worker.runReplayHistory({ workflowBundle }, history);
        });
        if (!explicit) {
          const proxyPath = path.join(directory, 'proxy.ts');
          const proxyApi = local ? 'proxyLocalActivities' : 'proxyActivities';
          await writeFile(
            proxyPath,
            `
            import { ${proxyApi} } from '@temporalio/workflow';
            const { echo } = ${proxyApi}<{ echo(value: string): Promise<string> }>({ startToCloseTimeout: '1m' });
            export async function main() { return await echo('hello'); }
          `
          );
          const proxyTaskQueue = randomUUID();
          const proxyWorker = await Worker.create({
            connection: env.nativeConnection,
            namespace: env.client.options.namespace,
            taskQueue: proxyTaskQueue,
            workflowBundle: await bundleWorkflowCode({ workflowsPath: proxyPath }),
            activities: { echo: async (value: string) => value },
          });
          const proxyHistory = await proxyWorker.runUntil(async () => {
            const handle = await env.client.workflow.start('main', {
              taskQueue: proxyTaskQueue,
              workflowId: randomUUID(),
            });
            await handle.result();
            return await handle.fetchHistory();
          });
          await Worker.runReplayHistory({ workflowBundle }, proxyHistory);
        }
      });
    }
  }

  for (const directStubCall of [false, true]) {
    test(`${directStubCall ? 'direct stub invocation' : 'missing import attribute'} reports a Workflow Task failure`, async (t) => {
      const directory = await fixture(t);
      // This implementation is workflow-safe to load, but must never be invoked.
      await writeFile(
        path.join(directory, 'safe-acts.ts'),
        `export async function echo(value: string): Promise<string> { throw new Error('IMPLEMENTATION_INVOKED'); }`
      );
      const workflowsPath = path.join(directory, 'workflow.ts');
      const broken = directStubCall
        ? `import { echo } from './safe-acts' with { temporal: 'activity' };
           export async function main() { return await echo('hello'); }`
        : `import { echo } from './safe-acts';
           import { executeActivity } from '@temporalio/workflow';
           const wrap = (activity: typeof echo) => executeActivity(activity, { args: ['hello'], startToCloseTimeout: '1m' });
           export async function main() { return await wrap(echo); }`;
      await writeFile(workflowsPath, broken);
      const { env } = t.context;
      const taskQueue = randomUUID();
      const handle = await env.client.workflow.start('main', { taskQueue, workflowId: randomUUID() });
      const options = {
        connection: env.nativeConnection,
        namespace: env.client.options.namespace,
        taskQueue,
        activities: { echo: async (value: string) => value },
      };
      const brokenBundle = await bundleWorkflowCode({ workflowsPath });
      const worker = await Worker.create({ ...options, workflowBundle: brokenBundle });
      await worker.runUntil(async () => {
        try {
          const history = await asyncRetry(
            async () => {
              const history = await handle.fetchHistory();
              if (!history.events?.some((event) => event.workflowTaskFailedEventAttributes)) {
                throw new Error('Waiting for Workflow Task failure');
              }
              return history;
            },
            { minTimeout: 100, maxTimeout: 500, retries: 40 }
          );
          const failure = history.events!.find((event) => event.workflowTaskFailedEventAttributes)!
            .workflowTaskFailedEventAttributes!.failure!;
          t.regex(failure.message ?? '', /Mark the Activity import with \{ temporal: 'activity' \}/);
          t.false(failure.message?.includes('IMPLEMENTATION_INVOKED'));
          t.false(history.events?.some((event) => event.workflowExecutionFailedEventAttributes));
          t.false(history.events?.some((event) => event.activityTaskScheduledEventAttributes));
          t.is((await handle.describe()).status.name, 'RUNNING');
        } finally {
          await handle.terminate();
        }
      });
    });
  }
}
