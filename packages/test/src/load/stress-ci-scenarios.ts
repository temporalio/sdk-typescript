import { Spec, AllInOneArgSpec } from './args';

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

export const activityCancellation10kIters: Args = {
  ...baseArgs,
  '--iterations': 10_000,
  '--workflow': 'cancelFakeProgress',
  '--max-cached-wfs': 500,
};

export const queryWithSmallCache1kIters: Args = {
  ...baseArgs,
  '--iterations': 1000,
  '--workflow': 'smorgasbord',
  '--max-cached-wfs': 5,
  '--max-concurrent-wft-executions': 5,
};
