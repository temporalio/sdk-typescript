import type { SerializedTool } from '@openai/agents-core';
import { ApplicationFailure } from '@temporalio/common';

/**
 * The hosted tool a credential is being requested for, identified by the
 * non-secret configuration the Workflow declared. A shell or code interpreter
 * tool carries its own `name`; every tool `hostedMcpTool()` builds is named
 * `hosted_mcp`, so `serverLabel` with `serverUrl` or `connectorId` is what
 * separates two of those — two sharing all three are indistinguishable here.
 */
export type HostedToolIdentity =
  | { tool: 'hostedMcp'; name: string; serverLabel: string; serverUrl?: string; connectorId?: string }
  | { tool: 'shell'; name: string; allowedDomains: string[] }
  | { tool: 'codeInterpreter'; name: string; allowedDomains: string[] };

/** Domain-scoped secret for one allowlisted domain of a shell or code interpreter tool. */
export interface HostedToolDomainSecret {
  domain: string;
  name: string;
  value: string;
}

/**
 * Credentials for one hosted tool. `authorization` and `headers` apply to a
 * hosted MCP tool; `domainSecrets` to a shell or code interpreter tool.
 *
 * A field left `undefined` or `null` is a silent no-op: the tool goes to the
 * model provider without that credential and nothing fails, so a resolver
 * reading `process.env` should throw when the variable is unset rather than pass
 * the `undefined` through. A field present in the wrong shape fails the model
 * Activity non-retryably instead.
 */
export interface HostedToolCredentials {
  authorization?: string;
  headers?: Record<string, string>;
  domainSecrets?: HostedToolDomainSecret[];
}

/**
 * Resolves the credentials for one hosted tool, Worker-side.
 *
 * Called for every hosted tool that has somewhere to put a credential, on each
 * model invocation, so a deployment that reads from a secret manager should
 * cache. A hosted MCP tool needs a server label to be asked about; a shell tool
 * needs a `container_auto` environment with a domain allowlist; a code
 * interpreter needs an inline container definition with a domain allowlist —
 * naming an existing container by id skips the callback even though that
 * container may carry an allowlist of its own. Only the fields the Workflow left
 * out are filled in; return nothing to leave a tool as the Workflow declared it.
 *
 * A throw fails the model Activity: an `ApplicationFailure` keeps its own
 * retryability, anything else fails non-retryably. Either way the error's own
 * message reaches Workflow history, so keep credentials out of it.
 */
export type HostedToolCredentialsResolver = (
  identity: HostedToolIdentity
) => HostedToolCredentials | undefined | Promise<HostedToolCredentials | undefined>;

type SerializedShellTool = Extract<SerializedTool, { type: 'shell' }>;
type SerializedHostedTool = Extract<SerializedTool, { type: 'hosted_tool' }>;

function describeIdentity(identity: HostedToolIdentity): string {
  if (identity.tool === 'hostedMcp') {
    const server = identity.serverUrl ?? identity.connectorId ?? 'no server url or connector id';
    return `hosted MCP tool '${identity.name}' (server label '${identity.serverLabel}', ${server})`;
  }
  const kind = identity.tool === 'shell' ? 'shell tool' : 'code interpreter tool';
  const allowing = identity.allowedDomains.length === 0 ? '' : ` allowing ${identity.allowedDomains.join(', ')}`;
  return `${kind} '${identity.name}'${allowing}`;
}

/** Neither the message nor the identity ever carries a credential value. */
async function credentialsFor(
  identity: HostedToolIdentity,
  resolve: HostedToolCredentialsResolver
): Promise<HostedToolCredentials | undefined> {
  let resolved: unknown;
  try {
    resolved = await resolve(identity);
  } catch (error) {
    // A secret manager that is transiently down throws a retryable
    // ApplicationFailure; rewrapping it would strip that classification.
    if (error instanceof ApplicationFailure) throw error;
    throw ApplicationFailure.create({
      message: `Cannot resolve credentials for ${describeIdentity(identity)}.`,
      type: 'HostedToolCredentialsError',
      nonRetryable: true,
      cause: error instanceof Error ? error : new Error(String(error)),
    });
  }
  // Outside the catch above, which would misreport a malformed return as a
  // resolver that threw.
  return validatedCredentials(identity, resolved);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Says what a value is without saying what it holds. */
function describeValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

function unusableCredentials(identity: HostedToolIdentity, problem: string): ApplicationFailure {
  return ApplicationFailure.create({
    message: `Cannot use the credentials resolved for ${describeIdentity(identity)}: ${problem}.`,
    type: 'HostedToolCredentialsShapeError',
    nonRetryable: true,
  });
}

/**
 * A resolver that reads a secret manager hands back whatever `JSON.parse` gave
 * it, so a field can arrive in the wrong shape without any type error. Writing
 * one through spreads a string character-wise over the outgoing headers or throws
 * a `TypeError` Temporal retries, and either way the tool reaches the model
 * provider unauthenticated. Failing here names the tool and the field, never the
 * value.
 */
function validatedCredentials(identity: HostedToolIdentity, resolved: unknown): HostedToolCredentials | undefined {
  if (resolved == null) return undefined;
  if (!isRecord(resolved)) {
    throw unusableCredentials(identity, `expected an object, got ${describeValue(resolved)}`);
  }

  const { authorization, headers, domainSecrets } = resolved;
  const validated: HostedToolCredentials = {};

  if (authorization != null) {
    if (typeof authorization !== 'string') {
      throw unusableCredentials(identity, `'authorization' must be a string, got ${describeValue(authorization)}`);
    }
    validated.authorization = authorization;
  }

  if (headers != null) {
    if (!isRecord(headers)) {
      throw unusableCredentials(identity, `'headers' must be an object, got ${describeValue(headers)}`);
    }
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') {
        throw unusableCredentials(identity, `'headers' entry '${key}' must be a string, got ${describeValue(value)}`);
      }
    }
    validated.headers = headers as Record<string, string>;
  }

  if (domainSecrets != null) {
    if (!Array.isArray(domainSecrets)) {
      throw unusableCredentials(identity, `'domainSecrets' must be an array, got ${describeValue(domainSecrets)}`);
    }
    for (const [index, secret] of domainSecrets.entries()) {
      if (!isRecord(secret)) {
        throw unusableCredentials(
          identity,
          `'domainSecrets' entry ${index} must be an object, got ${describeValue(secret)}`
        );
      }
      for (const field of ['domain', 'name', 'value'] as const) {
        if (typeof secret[field] !== 'string') {
          throw unusableCredentials(
            identity,
            `'domainSecrets' entry ${index} must have a string '${field}', got ${describeValue(secret[field])}`
          );
        }
      }
    }
    validated.domainSecrets = domainSecrets as HostedToolDomainSecret[];
  }

  return validated;
}

/**
 * Returns the merged headers, or `undefined` to leave the tool alone. A declared
 * value the callback did not supply passes through untouched, so the merged
 * headers are not necessarily all strings.
 */
function fillHeaders(
  declared: unknown,
  supplied: Record<string, string> | undefined
): Record<string, unknown> | undefined {
  if (supplied === undefined) return undefined;
  // The wire types allow `null`, and a value carried over from an API response can be one.
  const base = declared ?? {};
  if (!isRecord(base)) return undefined;
  const missing = Object.entries(supplied).filter(
    ([key]) => (Object.prototype.hasOwnProperty.call(base, key) ? base[key] : undefined) == null
  );
  if (missing.length === 0) return undefined;
  return { ...base, ...Object.fromEntries(missing) };
}

/**
 * A domain secret is identified by its domain and name, so a declared one is
 * never replaced — unless its value is `null`, which declares no credential and
 * is dropped in favour of the supplied entry. Declared entries pass through in
 * whatever shape the Workflow sent them, so the result is not necessarily a
 * list of well-formed secrets.
 */
function fillDomainSecrets(declared: unknown, supplied: HostedToolDomainSecret[] | undefined): unknown[] | undefined {
  if (supplied === undefined) return undefined;
  const base = declared ?? [];
  if (!Array.isArray(base)) return undefined;
  const missing = supplied.filter(
    (secret) =>
      !base.some((entry) => entry?.domain === secret.domain && entry?.name === secret.name && entry?.value != null)
  );
  if (missing.length === 0) return undefined;
  const kept = base.filter((entry) => !missing.some((s) => s.domain === entry?.domain && s.name === entry?.name));
  return [...kept, ...missing];
}

async function injectHostedMcp(
  tool: SerializedHostedTool,
  providerData: Record<string, any>,
  resolve: HostedToolCredentialsResolver
): Promise<SerializedHostedTool> {
  const serverLabel = providerData.server_label;
  if (typeof serverLabel !== 'string' || serverLabel === '') return tool;

  const credentials = await credentialsFor(
    {
      tool: 'hostedMcp',
      name: tool.name,
      serverLabel,
      ...(typeof providerData.server_url === 'string' && { serverUrl: providerData.server_url }),
      ...(typeof providerData.connector_id === 'string' && { connectorId: providerData.connector_id }),
    },
    resolve
  );
  const authorization = providerData.authorization == null ? credentials?.authorization : undefined;
  const headers = fillHeaders(providerData.headers, credentials?.headers);
  if (authorization === undefined && headers === undefined) return tool;

  return {
    ...tool,
    providerData: {
      ...providerData,
      ...(authorization !== undefined && { authorization }),
      ...(headers !== undefined && { headers }),
    },
  };
}

async function injectCodeInterpreter(
  tool: SerializedHostedTool,
  providerData: Record<string, any>,
  resolve: HostedToolCredentialsResolver
): Promise<SerializedHostedTool> {
  // `container` may be a bare container id string, which has no allowlist to key on.
  const container = providerData.container;
  if (!isRecord(container)) return tool;
  const policy = container.network_policy;
  if (!isRecord(policy) || policy.type !== 'allowlist' || !Array.isArray(policy.allowed_domains)) return tool;

  const credentials = await credentialsFor(
    { tool: 'codeInterpreter', name: tool.name, allowedDomains: [...policy.allowed_domains] },
    resolve
  );
  const domainSecrets = fillDomainSecrets(policy.domain_secrets, credentials?.domainSecrets);
  if (domainSecrets === undefined) return tool;

  return {
    ...tool,
    providerData: {
      ...providerData,
      container: { ...container, network_policy: { ...policy, domain_secrets: domainSecrets } },
    },
  };
}

async function injectShell(
  tool: SerializedShellTool,
  resolve: HostedToolCredentialsResolver
): Promise<SerializedShellTool> {
  // `local` and `container_reference` environments have no allowlist to key on.
  const environment = tool.environment;
  if (environment?.type !== 'container_auto') return tool;
  const policy = environment.networkPolicy;
  if (policy?.type !== 'allowlist' || !Array.isArray(policy.allowedDomains)) return tool;

  const credentials = await credentialsFor(
    { tool: 'shell', name: tool.name, allowedDomains: [...policy.allowedDomains] },
    resolve
  );
  const domainSecrets = fillDomainSecrets(policy.domainSecrets, credentials?.domainSecrets);
  if (domainSecrets === undefined) return tool;

  return {
    ...tool,
    environment: {
      ...environment,
      networkPolicy: { ...policy, domainSecrets: domainSecrets as typeof policy.domainSecrets },
    },
  };
}

async function injectTool(tool: SerializedTool, resolve: HostedToolCredentialsResolver): Promise<SerializedTool> {
  if (tool.type === 'shell') return injectShell(tool, resolve);
  if (tool.type !== 'hosted_tool') return tool;
  const providerData = tool.providerData;
  if (providerData?.type === 'mcp') return injectHostedMcp(tool, providerData, resolve);
  if (providerData?.type === 'code_interpreter') return injectCodeInterpreter(tool, providerData, resolve);
  return tool;
}

/** Clones each tool it fills in rather than writing into the Activity input. */
export async function injectHostedToolCredentials(
  tools: SerializedTool[],
  resolve: HostedToolCredentialsResolver
): Promise<SerializedTool[]> {
  const injected: SerializedTool[] = [];
  for (const tool of tools) {
    injected.push(await injectTool(tool, resolve));
  }
  return injected;
}
