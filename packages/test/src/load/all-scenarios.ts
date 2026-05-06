import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { msToNumber } from '@temporalio/common/lib/time';
import * as workflows from '../workflows';
import type { Spec, AllInOneArgSpec } from './args';

export type EvaluatedArgs<T extends Spec> = {
  [K in keyof T]?: ReturnType<T[K]>;
};

type Args = EvaluatedArgs<AllInOneArgSpec>;

const TEMPORAL_TESTING_SERVER_URL = process.env.TEMPORAL_TESTING_SERVER_URL;
const TEMPORAL_TESTING_LOG_DIR = process.env.TEMPORAL_TESTING_LOG_DIR;
const TEMPORAL_TESTING_MEM_LOG_DIR = process.env.TEMPORAL_TESTING_MEM_LOG_DIR;

// Use the default unless provided
const baseArgs: Args = {
  ...(TEMPORAL_TESTING_SERVER_URL ? { '--server-address': TEMPORAL_TESTING_SERVER_URL } : undefined),
  '--status-port': 6666,
};

const smallCacheArgs: Args = {
  '--max-cached-wfs': 3,
  '--max-concurrent-wft-executions': 3,
};

export const activityCancellation10kIters: Args = {
  ...baseArgs,
  '--iterations': 10_000,
  '--max-cached-wfs': 500,
  '--workflow': workflows.cancelFakeProgress.name,
};

export const queryWithSmallCache100Iters: Args = {
  ...baseArgs,
  ...smallCacheArgs,
  '--iterations': 100,
  '--workflow': workflows.smorgasbord.name,
};

export const longHistoriesWithSmallCache100Iters: Args = {
  ...baseArgs,
  ...smallCacheArgs,
  '--iterations': 100,
  '--workflow': workflows.longHistoryGenerator.name,
};

export const longHaul: Args = {
  ...baseArgs,
  '--for-seconds': msToNumber('4h') / 1000,
  '--min-wfs-per-sec': 5,
  '--concurrent-wf-clients': 100,
  '--workflow': workflows.cancelFakeProgress.name,
};

const samplerWorkflows = [
  workflows.cancelFakeProgress,
  workflows.childWorkflowCancel,
  workflows.childWorkflowSignals,
  workflows.smorgasbord,
];

export const samplers = Object.fromEntries(
  samplerWorkflows.map((workflow): [string, Args] => [
    `sampler_${workflow.name}`,
    {
      ...baseArgs,
      '--iterations': 1000,
      '--workflow': workflow.name,
      '--min-wfs-per-sec': 5,
      '--max-cached-wfs': 500,
    },
  ])
);

export function runScenarios(scenarios: Record<string, Args>): void {
  for (const [name, origConfig] of Object.entries(scenarios)) {
    let config = origConfig;
    if (TEMPORAL_TESTING_LOG_DIR) {
      config = {
        ...origConfig,
        '--log-file': path.join(TEMPORAL_TESTING_LOG_DIR, `${name}.log`),
        '--log-level': 'DEBUG',
      };
    }
    if (TEMPORAL_TESTING_MEM_LOG_DIR) {
      config['--worker-memory-log-file'] = path.join(TEMPORAL_TESTING_MEM_LOG_DIR, `${name}.log`);
    }
    console.log('*'.repeat(120));
    console.log('Running test scenario:', name, { config });
    console.log('*'.repeat(120));

    const { error, signal, status } = spawnSync(
      'node',
      [require.resolve('./all-in-one'), ...Object.entries(config).flatMap(([k, v]) => [k, `${v}`])],
      {
        stdio: 'inherit',
      }
    );
    if (status !== 0) {
      throw new Error(`Test failed with status: ${status}, signal: ${signal}, error: ${error?.message}`);
    }

    console.log('*'.repeat(120));
    console.log('End test scenario:', name);
    console.log('*'.repeat(120));
  }
}
