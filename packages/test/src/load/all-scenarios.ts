import { Spec, AllInOneArgSpec } from './args';
import * as workflows from '../workflows';
import ms from 'ms';

export type EvaluatedArgs<T extends Spec> = {
  [K in keyof T]?: ReturnType<T[K]>;
};

type Args = EvaluatedArgs<AllInOneArgSpec>;

const TEMPORAL_TESTING_SERVER_URL = process.env.TEMPORAL_TESTING_SERVER_URL;
if (TEMPORAL_TESTING_SERVER_URL == null) {
  throw new Error('Missing TEMPORAL_TESTING_SERVER_URL env var');
}

const baseArgs: Args = {
  '--server-address': TEMPORAL_TESTING_SERVER_URL,
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
