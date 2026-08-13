import { ApplicationFailure } from '@temporalio/common';

const SECRET_REF_PREFIX = 'temporal:secret-ref/';

/**
 * Returns a marker referencing a Worker environment variable, to use in place
 * of a literal credential so the credential stays out of the Activity arguments
 * that the model call records in Workflow history. The Worker resolves it from
 * `process.env` when the model Activity starts; a variable that is unset or
 * empty fails the Activity non-retryably with a `SecretReferenceError`, naming
 * the variable.
 *
 * Only the tool credential fields the plugin knows about are resolved: a hosted
 * MCP tool's `authorization` and `headers`, a hosted shell tool's
 * `environment.networkPolicy.domainSecrets[].value`, and a code-interpreter
 * tool's `container.network_policy.domain_secrets[].value`. A reference placed
 * anywhere else is passed through as this literal marker string.
 *
 * ```ts
 * hostedMcpTool({ serverLabel: 'docs', serverUrl, authorization: secretRef('DOCS_MCP_TOKEN') })
 * ```
 *
 * @throws {ApplicationFailure} of type `SecretReferenceNameError`, synchronously at
 * the call site, when `name` is empty or contains whitespace.
 */
export function secretRef(name: string): string {
  assertSecretRefName(name);
  return `${SECRET_REF_PREFIX}${name}`;
}

export function secretRefName(value: string): string | undefined {
  return value.startsWith(SECRET_REF_PREFIX) ? value.slice(SECRET_REF_PREFIX.length) : undefined;
}

/** @throws {ApplicationFailure} of type `SecretReferenceNameError`. */
export function assertSecretRefName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name === '' || /\s/.test(name)) {
    throw ApplicationFailure.create({
      message: `Invalid secret reference name '${String(name)}': must be a non-empty string free of whitespace.`,
      type: 'SecretReferenceNameError',
      nonRetryable: true,
    });
  }
}

/** Neither `field` nor the resulting message ever carries the value. */
export function resolveWorkerEnvSecret(name: string, field: string): string {
  const resolved = process.env[name];
  if (!resolved) {
    throw ApplicationFailure.create({
      message:
        `Cannot resolve the secret reference on ${field}: Worker environment variable ` +
        `'${name}' is ${resolved === undefined ? 'not set' : 'empty'}.`,
      type: 'SecretReferenceError',
      nonRetryable: true,
    });
  }
  return resolved;
}
