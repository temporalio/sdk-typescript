import { Spec, AllInOneArgSpec } from './args';
import * as workflows from '../workflows';

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
  '--otel-url': '',
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

export const queryWithSmallCache1kIters: Args = {
  ...baseArgs,
  ...smallCacheArgs,
  '--iterations': 1000,
  '--workflow': workflows.smorgasbord.name,
};

export const longHistoriesWithSmallCache100Iters: Args = {
  ...baseArgs,
  ...smallCacheArgs,
  '--iterations': 100,
  '--workflow': workflows.longHistoryGenerator.name,
};
