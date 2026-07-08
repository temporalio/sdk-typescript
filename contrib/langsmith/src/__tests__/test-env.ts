/**
 * Environment tracing gate end-to-end.
 *
 * Tracing is OFF by default and turns on only when a recognized LangSmith
 * tracing env var is explicitly `"true"`. Two suppression paths must emit
 * nothing — no client markers, no workflow-operation runs, no activity runs:
 *  - the explicit tracing gate (`LANGSMITH_TRACING="false"`), and
 *  - the default, with no recognized tracing env var set at all.
 * Each boots a real local environment and runs a workflow with no user
 * `traceable` anywhere, so an empty collector proves the plugin itself emitted
 * nothing rather than merely that there was nothing to emit.
 *
 * The recognized flags are saved and restored around each case so a
 * non-isolated test pool does not leak state into sibling files or each other.
 * The two cases mutate the same process env, so they run serially.
 *
 * @module
 */

import test from 'ava';

import * as activities from './activities/langsmith';
import { InMemoryRunCollector, withTracingWorker } from './helpers';
import * as workflows from './workflows/langsmith';

const TRACING_ENV_VARS = ['LANGSMITH_TRACING', 'LANGSMITH_TRACING_V2', 'LANGCHAIN_TRACING_V2', 'LANGCHAIN_TRACING'];

function snapshotTracingEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const name of TRACING_ENV_VARS) {
    snapshot[name] = process.env[name];
  }
  return snapshot;
}

function restoreTracingEnv(snapshot: Record<string, string | undefined>): void {
  for (const name of TRACING_ENV_VARS) {
    const value = snapshot[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

async function runPlainWorkflow(collector: InMemoryRunCollector): Promise<void> {
  await withTracingWorker({
    collector,
    options: { addTemporalRuns: true },
    activities: { plainActivity: activities.plainActivity },
    body: async ({ client, taskQueue }) => {
      await client.workflow.execute(workflows.PlainWorkflow, {
        taskQueue,
        workflowId: `env-${Date.now()}`,
        args: ['hi'],
      });
    },
  });
}

test.serial('LANGSMITH_TRACING=false suppresses all emission', async (t) => {
  const snapshot = snapshotTracingEnv();
  process.env.LANGSMITH_TRACING = 'false';
  try {
    const collector = new InMemoryRunCollector();
    await runPlainWorkflow(collector);
    t.deepEqual(collector.records, []);
  } finally {
    restoreTracingEnv(snapshot);
  }
});

test.serial('default-off: suppresses all emission when no recognized tracing env var is set', async (t) => {
  const snapshot = snapshotTracingEnv();
  for (const name of TRACING_ENV_VARS) {
    delete process.env[name];
  }
  try {
    const collector = new InMemoryRunCollector();
    await runPlainWorkflow(collector);
    t.deepEqual(collector.records, []);
  } finally {
    restoreTracingEnv(snapshot);
  }
});
