/**
 */

import arg from 'arg';

export interface SetupArgSpec extends arg.Spec {
  '--ns': typeof String;
  '--server-address': typeof String;
}

export const setupArgSpec: SetupArgSpec = {
  '--ns': String,
  '--server-address': String,
};

export interface StarterArgSpec extends arg.Spec {
  '--iterations': typeof Number;
  '--workflow': typeof String;
  '--ns': typeof String;
  '--task-queue': typeof String;
  '--concurrent-wf-clients': typeof Number;
  '--server-address': typeof String;
}

export const starterArgSpec: StarterArgSpec = {
  '--iterations': Number,
  '--workflow': String,
  '--ns': String,
  '--task-queue': String,
  '--concurrent-wf-clients': Number,
  '--server-address': String,
};

export interface WorkerArgSpec extends arg.Spec {
  '--ns': typeof String;
  '--task-queue': typeof String;
  '--max-cached-wfs': typeof Number;
  '--max-concurrent-at-executions': typeof Number;
  '--max-concurrent-wft-executions': typeof Number;
  '--isolate-pool-size': typeof Number;
  // NOTE: this is not supported yet by Core
  '--max-concurrent-at-polls': typeof Number;
  // NOTE: this is not supported yet by Core
  '--max-concurrent-wft-polls': typeof Number;
  '--log-level': typeof String;
  '--server-address': typeof String;
}

export const workerArgSpec: WorkerArgSpec = {
  '--ns': String,
  '--task-queue': String,
  '--max-cached-wfs': Number,
  '--max-concurrent-at-executions': Number,
  '--max-concurrent-wft-executions': Number,
  '--isolate-pool-size': Number,
  // NOTE: this is not supported yet by Core
  '--max-concurrent-at-polls': Number,
  // NOTE: this is not supported yet by Core
  '--max-concurrent-wft-polls': Number,
  '--log-level': String,
  '--server-address': String,
};

export type AllInOneArgSpec = SetupArgSpec & StarterArgSpec & WorkerArgSpec;

export function getRequired<T extends arg.Spec, K extends keyof T>(
  args: arg.Result<T>,
  k: K
): Exclude<arg.Result<T>[K], undefined> {
  const v = args[k];
  if (v === undefined) {
    throw new Error(`Option ${k} is required`);
  }
  return v as any; // Type assertion above does not narrow down the type of v
}
