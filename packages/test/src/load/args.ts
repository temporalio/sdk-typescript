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
  '--min-wfs-per-sec': typeof Number;
  '--iterations': typeof Number;
  '--for-seconds': typeof Number;
  '--workflow': typeof String;
  '--ns': typeof String;
  '--task-queue': typeof String;
  '--concurrent-wf-clients': typeof Number;
  '--server-address': typeof String;
  '--worker-pid': typeof Number;
  '--do-query': typeof String;
  '--ms-between-queries': typeof Number;
}

export const starterArgSpec: StarterArgSpec = {
  '--min-wfs-per-sec': Number,
  '--iterations': Number,
  '--for-seconds': Number,
  '--workflow': String,
  '--ns': String,
  '--task-queue': String,
  '--concurrent-wf-clients': Number,
  '--server-address': String,
  '--worker-pid': Number,
  '--do-query': String,
  '--ms-between-queries': Number,
};

export interface WorkerArgSpec extends arg.Spec {
  '--ns': typeof String;
  '--task-queue': typeof String;
  '--max-cached-wfs': typeof Number;
  '--max-concurrent-at-executions': typeof Number;
  '--max-concurrent-wft-executions': typeof Number;
  // NOTE: this is not supported yet by Core
  '--max-concurrent-at-polls': typeof Number;
  // NOTE: this is not supported yet by Core
  '--max-concurrent-wft-polls': typeof Number;
  '--log-level': typeof String;
  '--server-address': typeof String;
  '--otel-url': typeof String;
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
  '--otel-url': String,
};

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
