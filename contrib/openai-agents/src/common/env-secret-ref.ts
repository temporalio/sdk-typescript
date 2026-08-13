import { EnvValueReference, registerEnvValueReference } from '@openai/agents-core/sandbox';
import { ApplicationFailure } from '@temporalio/common';
import { assertSecretRefName, resolveWorkerEnvSecret } from './secret-ref';

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
    return resolveWorkerEnvSecret(this.name, `manifest environment value '${this.name}'`);
  }
}

try {
  registerEnvValueReference(WorkerEnvSecretReference, (payload) => {
    assertSecretRefName(payload.name);
    return new WorkerEnvSecretReference(payload.name);
  });
} catch (err) {
  // The type tag is namespaced, so the only way to collide is a second copy of this
  // package registering against the shared peer agents-core. Any other rejection
  // (missing static type, non-string tag) is a real defect in this file.
  if (!(err instanceof TypeError) || !err.message.includes('is already registered by')) throw err;
}

/**
 * Returns a Manifest environment value that references a Worker environment
 * variable instead of holding a credential. Only the variable name crosses into
 * the Activity arguments that every sandbox operation records in Workflow
 * history; the Worker resolves the value from `process.env` when the sandbox
 * backend materializes the environment.
 *
 * A variable that is unset or empty fails the Activity non-retryably with a
 * `SecretReferenceError`, naming the variable. The SDK persists the `{ type, name }`
 * marker but never the resolved value, so a reference never needs `ephemeral: true`.
 *
 * ```ts
 * new Manifest({ environment: { DB_PASSWORD: envSecretRef('WORKER_DB_PASSWORD') } })
 * ```
 *
 * @throws {ApplicationFailure} of type `SecretReferenceNameError` when `name` is
 * empty or contains whitespace.
 */
export function envSecretRef(name: string): EnvValueReference {
  assertSecretRefName(name);
  return new WorkerEnvSecretReference(name);
}
