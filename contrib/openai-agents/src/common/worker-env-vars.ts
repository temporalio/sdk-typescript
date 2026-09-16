import { EnvValueReference, registerEnvValueReference, type Environment } from '@openai/agents-core/sandbox';
import { ApplicationFailure } from '@temporalio/common';

let workerEnvVarContext: (() => readonly string[] | undefined) | undefined;

export function registerWorkerEnvVarContext(context: () => readonly string[] | undefined): void {
  workerEnvVarContext ??= context;
}

/**
 * Returns the value of an allowlisted Worker environment variable, the empty
 * string if it is unset or empty, or `undefined` if the allowlist does not cover it.
 *
 * @internal
 */
export function readWorkerEnvVar(name: string, resolvable: readonly string[]): string | undefined {
  if (!resolvable.includes('*') && !resolvable.includes(name)) return undefined;
  const value = process.env[name];
  return typeof value === 'string' ? value : '';
}

class WorkerEnvValue extends EnvValueReference {
  static readonly type = 'temporal.worker-env-value';

  constructor(
    readonly name: string,
    private resolvableWorkerEnvVars: readonly string[] = workerEnvVarContext?.() ?? []
  ) {
    super();
  }

  bind(names: readonly string[]): void {
    this.resolvableWorkerEnvVars = names;
  }

  serialize(): Record<string, unknown> {
    return { name: this.name };
  }

  async resolve(): Promise<string> {
    const value = readWorkerEnvVar(this.name, this.resolvableWorkerEnvVars);
    if (value === undefined) {
      throw ApplicationFailure.create({
        message:
          `Cannot resolve Worker environment variable '${this.name}': it is not in the OpenAIAgentsPlugin ` +
          "'resolvableWorkerEnvVars' allowlist.",
        type: 'WorkerEnvValueError',
        nonRetryable: true,
      });
    }
    return value;
  }
}

export function bindWorkerEnvVarReferences(environment: Record<string, Environment>, names: readonly string[]): void {
  for (const value of Object.values(environment)) {
    if (value instanceof WorkerEnvValue) value.bind(names);
  }
}

registerEnvValueReference(WorkerEnvValue, (payload) => {
  if (typeof payload.name !== 'string') {
    throw ApplicationFailure.create({
      message: `A persisted Worker environment value must name a variable: got ${typeof payload.name}, not a string.`,
      type: 'WorkerEnvValueError',
      nonRetryable: true,
    });
  }
  return new WorkerEnvValue(payload.name);
});

/**
 * Returns a Manifest environment value that names a Worker environment variable
 * instead of holding a credential. Only the variable name crosses into the
 * Activity arguments that every sandbox operation records in Workflow history;
 * the Worker reads the value from its own environment when the sandbox backend
 * materializes the environment.
 *
 * The name must be in the plugin's `resolvableWorkerEnvVars` allowlist — a
 * sandbox environment value has no way to say "leave this one out", so any other
 * name fails the Activity non-retryably with a `WorkerEnvValueError`, naming the
 * variable. An allowlisted variable that is unset or empty reads as the empty
 * string.
 *
 * ```ts
 * new Manifest({ environment: { DB_PASSWORD: workerEnvValue('WORKER_DB_PASSWORD') } })
 * ```
 */
export function workerEnvValue(name: string): EnvValueReference {
  return new WorkerEnvValue(name);
}
