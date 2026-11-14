import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'ava';
import type { Client } from '@temporalio/client';
import type { temporal } from '@temporalio/proto';
import type { WorkerOptions } from '@temporalio/worker';
import { Worker } from '@temporalio/worker';
import workerPackage from '@temporalio/worker/package.json';
import { loadHistory, saveHistory } from './helpers';
import type { HelperTestBundleOptions } from './helpers-integration';
import { createLocalTestEnvironment, createTestWorkflowBundle } from './helpers-integration';

type History = temporal.api.history.v1.IHistory;

export interface WorkflowHistoryTestOptions extends Omit<HelperTestBundleOptions, 'payloadConverterPath'> {
  title: string;
  sdkVersion: string;
  filename: string;
  workerOptions?: Pick<WorkerOptions, 'activities' | 'dataConverter'>;
  generate: (client: Client, taskQueue: string) => Promise<History>;
}

/**
 * Register a replay test, or an opt-in serial capture on the producing SDK checkout.
 * The callback owns workflow inputs/signals and returns one history.
 */
export function testWorkflowHistory(opts: WorkflowHistoryTestOptions): void {
  const captureVersion = process.env.TEMPORAL_CAPTURE_HISTORY;
  const createBundle = () =>
    createTestWorkflowBundle({
      ...opts,
      payloadConverterPath: opts.workerOptions?.dataConverter?.payloadConverterPath,
    });

  if (captureVersion !== undefined) {
    assert.equal(captureVersion, opts.sdkVersion, `Set TEMPORAL_CAPTURE_HISTORY=${opts.sdkVersion}`);
    assert.equal(workerPackage.version, opts.sdkVersion, 'Capture must run on the requested SDK');
    assert(
      !process.env.TEMPORAL_SERVICE_ADDRESS && !process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER,
      'Use a local test server'
    );

    test.serial(`capture ${opts.title} SDK ${opts.sdkVersion}`, async (t) => {
      t.timeout(120_000);
      const workflowBundle = await createBundle();
      const env = await createLocalTestEnvironment({ client: { dataConverter: opts.workerOptions?.dataConverter } });
      try {
        const taskQueue = `history-${randomUUID()}`;
        const worker = await Worker.create({
          ...opts.workerOptions,
          connection: env.nativeConnection,
          namespace: env.namespace,
          taskQueue,
          workflowBundle,
        });
        const history = await worker.runUntil(() => opts.generate(env.client, taskQueue));
        await saveHistory(opts.filename, history);
        t.pass();
      } finally {
        await env.teardown();
      }
    });
  } else {
    test(`replay ${opts.title} SDK ${opts.sdkVersion}`, async (t) => {
      await Worker.runReplayHistory(
        { workflowBundle: await createBundle(), dataConverter: opts.workerOptions?.dataConverter },
        await loadHistory(opts.filename)
      );
      t.pass();
    });
  }
}
