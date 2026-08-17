import { EnvValueReference, registerEnvValueReference } from '@openai/agents-core/sandbox';
import { ApplicationFailure } from '@temporalio/common';

function assertEnvVarName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name === '' || /\s/.test(name)) {
    throw ApplicationFailure.create({
      message: `Invalid Worker environment variable name '${String(
        name
      )}': must be a non-empty string free of whitespace.`,
      type: 'SecretReferenceNameError',
      nonRetryable: true,
    });
  }
}

class WorkerEnvSecretReference extends EnvValueReference {
  static readonly type = 'temporal.worker-env-secret';

  constructor(readonly name: string) {
    super();
  }

  serialize(): Record<string, unknown> {
    return { name: this.name };
  }

  async resolve(): Promise<string> {
    if (typeof process === 'undefined') {
      throw ApplicationFailure.create({
        message:
          `Cannot resolve the reference to Worker environment variable '${this.name}' inside the ` +
          'Workflow sandbox: a manifest environment reference resolves Worker-side only.',
        type: 'SecretReferenceError',
        nonRetryable: true,
      });
    }
    // A plain lookup walks the prototype chain: `toString` is a legal shell variable
    // name and would otherwise resolve to `Object.prototype.toString`.
    const resolved = Object.prototype.hasOwnProperty.call(process.env, this.name) ? process.env[this.name] : undefined;
    if (!resolved) {
      throw ApplicationFailure.create({
        message:
          'Cannot resolve the manifest environment reference: Worker environment variable ' +
          `'${this.name}' is ${resolved === undefined ? 'not set' : 'empty'}.`,
        type: 'SecretReferenceError',
        nonRetryable: true,
      });
    }
    return resolved;
  }
}

registerEnvValueReference(WorkerEnvSecretReference, (payload) => {
  assertEnvVarName(payload.name);
  return new WorkerEnvSecretReference(payload.name);
});

/**
 * Returns a Manifest environment value that references a Worker environment
 * variable instead of holding a credential. Only the variable name crosses into
 * the Activity arguments that every sandbox operation records in Workflow
 * history; the Worker resolves the value from `process.env` when the sandbox
 * backend materializes the environment.
 *
 * A variable that is unset or empty fails the Activity non-retryably with a
 * `SecretReferenceError`, naming the variable. The Activity argument carries the
 * `{ type, name }` marker alone, and so does the persisted session state of a
 * sandbox client that has no `serializeSessionState` of its own. A client that
 * defines one is handed the resolved environment instead, and must keep the
 * value out of what it returns or that plaintext lands in history. Marking a
 * literal value `ephemeral: true` does not do the same job: an ephemeral value
 * stays out of persisted session state but is still written in plaintext into
 * every sandbox Activity argument.
 *
 * ```ts
 * new Manifest({ environment: { DB_PASSWORD: envSecretRef('WORKER_DB_PASSWORD') } })
 * ```
 *
 * @throws {ApplicationFailure} of type `SecretReferenceNameError` when `name` is
 * empty or contains whitespace.
 */
export function envSecretRef(name: string): EnvValueReference {
  assertEnvVarName(name);
  return new WorkerEnvSecretReference(name);
}
