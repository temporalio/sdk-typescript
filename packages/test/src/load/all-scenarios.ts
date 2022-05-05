import ms from 'ms';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Spec, AllInOneArgSpec } from './args';
import * as workflows from '../workflows';

export type EvaluatedArgs<T extends Spec> = {
  [K in keyof T]?: ReturnType<T[K]>;
};

type Args = EvaluatedArgs<AllInOneArgSpec>;

const TEMPORAL_TESTING_SERVER_URL = process.env.TEMPORAL_TESTING_SERVER_URL;
const TEMPORAL_TESTING_LOG_DIR = process.env.TEMPORAL_TESTING_LOG_DIR;

// Use the default unless provided
const baseArgs: Args = {
  ...(TEMPORAL_TESTING_SERVER_URL ? { '--server-address': TEMPORAL_TESTING_SERVER_URL } : undefined),
};

const smallCacheArgs: Args = {
  '--max-cached-wfs': 3,
  '--max-concurrent-wft-executions': 3,
  '--status-port': 6666,
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
  '--for-seconds': ms('4h') / 1000,
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

export function runScenarios(scenarios: Record<string, Args>) {
  for (let [name, config] of Object.entries(scenarios)) {
    if (TEMPORAL_TESTING_LOG_DIR) {
      config = { ...config, '--log-file': path.join(TEMPORAL_TESTING_LOG_DIR, `${name}.log`), '--log-level': 'DEBUG' };
    }
    console.log('*'.repeat(120));
    console.log('Running test scenario:', name, { config });
    console.log('*'.repeat(120));

    spawnSync('node', [require.resolve('./all-in-one'), ...Object.entries(config).flatMap(([k, v]) => [k, `${v}`])], {
      stdio: 'inherit',
    });

    console.log('*'.repeat(120));
    console.log('End test scenario:', name);
    console.log('*'.repeat(120));
  }
}
