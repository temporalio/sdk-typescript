/**
 */

import arg from 'arg';

/**
 * Simplified version of `arg.Spec`, required to construct typed options
 */
export type Spec = Record<string, () => any>;

export interface SetupArgSpec extends Spec {
  '--ns': typeof String;
  '--server-address': typeof String;
}

export const setupArgSpec: SetupArgSpec = {
  '--ns': String,
  '--server-address': String,
};

export interface StarterArgSpec extends Spec {
  '--min-wfs-per-sec': typeof Number;
  '--iterations': typeof Number;
  '--for-seconds': typeof Number;
  '--workflow': typeof String;
  '--ns': typeof String;
  '--task-queue': typeof String;
  '--concurrent-wf-clients': typeof Number;
  '--server-address': typeof String;
  '--worker-pid': typeof Number;
  '--worker-memory-log-file': typeof String;
  '--do-query': typeof String;
  '--initial-query-delay-ms': typeof Number;
  '--query-interval-ms': typeof Number;
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
  '--worker-memory-log-file': String,
  '--do-query': String,
  '--initial-query-delay-ms': Number,
  '--query-interval-ms': Number,
};

export interface WorkerArgSpec extends Spec {
  '--ns': typeof String;
  '--task-queue': typeof String;
  '--max-cached-wfs': typeof Number;
  '--max-concurrent-at-executions': typeof Number;
  '--max-concurrent-wft-executions': typeof Number;
  '--max-concurrent-la-executions': typeof Number;
  '--log-level': typeof String;
  '--log-file': typeof String;
  '--server-address': typeof String;
  '--otel-url': typeof String;
  '--status-port': typeof Number;
}

export const workerArgSpec: WorkerArgSpec = {
  '--ns': String,
  '--task-queue': String,
  '--max-cached-wfs': Number,
  '--max-concurrent-at-executions': Number,
  '--max-concurrent-wft-executions': Number,
  '--max-concurrent-la-executions': Number,
  '--isolate-pool-size': Number,
  '--log-level': String,
  '--log-file': String,
  '--server-address': String,
  '--otel-url': String,
  '--status-port': Number,
};

export interface WrapperArgSpec extends Spec {
  '--inspect': typeof Boolean;
}

export const wrapperArgSpec: WrapperArgSpec = {
  '--inspect': Boolean,
};

export type AllInOneArgSpec = SetupArgSpec & StarterArgSpec & WorkerArgSpec & WrapperArgSpec;
export const allInOneArgSpec: AllInOneArgSpec = {
  ...setupArgSpec,
  ...starterArgSpec,
  ...workerArgSpec,
  ...wrapperArgSpec,
};

export function getRequired<T extends arg.Spec, K extends keyof T & string>(
  args: arg.Result<T>,
  k: K
): Exclude<arg.Result<T>[K], undefined> {
  const v = args[k];
  if (v === undefined) {
    throw new Error(`Option ${k} is required`);
  }
  return v as any; // Type assertion above does not narrow down the type of v
}
