import type { SerializedTool } from '@openai/agents-core';

/**
 * The hosted tool a credential is being requested for, identified by the
 * non-secret configuration the Workflow declared. A shell or code interpreter
 * tool carries its own `name`; every tool `hostedMcpTool()` builds is named
 * `hosted_mcp`, so `serverLabel` with `serverUrl` or `connectorId` is what
 * separates two of those — two sharing both are indistinguishable here.
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
 * hosted MCP tool; `domainSecrets` to a shell or code interpreter tool. A value
 * that is not a string — `undefined`, `null`, a value of some other type —
 * supplies no credential and fails nothing: that one field reaches the model
 * provider as the Workflow declared it while the rest are still filled in, so a
 * credential that never arrives surfaces as an authentication failure from the
 * tool provider rather than as a Temporal error.
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
 * A throw fails the model Activity, keeping whatever retryability it carries.
 * The error's own message reaches Workflow history, so keep credentials out of it.
 */
export type HostedToolCredentialsResolver = (
  identity: HostedToolIdentity
) => HostedToolCredentials | undefined | Promise<HostedToolCredentials | undefined>;

type SerializedShellTool = Extract<SerializedTool, { type: 'shell' }>;
type SerializedHostedTool = Extract<SerializedTool, { type: 'hosted_tool' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  if (!isRecord(supplied)) return undefined;
  // The wire types allow `null`, and a value carried over from an API response can be one.
  const base = declared ?? {};
  if (!isRecord(base)) return undefined;
  const filled = Object.entries(supplied).flatMap(([key, entry]) => {
    if (Object.hasOwn(base, key) && base[key] != null) return [];
    return typeof entry === 'string' ? [[key, entry] as const] : [];
  });
  if (filled.length === 0) return undefined;
  return { ...base, ...Object.fromEntries(filled) };
}

/**
 * A domain secret is identified by its domain and name, so a declared one is
 * never replaced — unless its value is `null`, which declares no credential and
 * is dropped in favour of the supplied entry. Entries pass through in whatever
 * shape the Workflow declared or the callback returned, so the result is not
 * necessarily a list of well-formed secrets.
 */
function fillDomainSecrets(declared: unknown, supplied: HostedToolDomainSecret[] | undefined): unknown[] | undefined {
  if (!Array.isArray(supplied)) return undefined;
  const base = declared ?? [];
  if (!Array.isArray(base)) return undefined;
  const missing = new Map<string, HostedToolDomainSecret>();
  for (const secret of supplied) {
    if (secret == null) continue;
    const isDeclared = base.some(
      (entry) => entry?.domain === secret.domain && entry?.name === secret.name && entry?.value != null
    );
    // JSON encodes the pair unambiguously, so no two distinct pairs share a key.
    if (!isDeclared) missing.set(JSON.stringify([secret.domain, secret.name]), secret);
  }
  const filled = [...missing.values()].flatMap((secret) => (typeof secret.value === 'string' ? [secret] : []));
  if (filled.length === 0) return undefined;
  const kept = base.filter((entry) => !filled.some((s) => s.domain === entry?.domain && s.name === entry?.name));
  return [...kept, ...filled];
}

async function injectHostedMcp(
  tool: SerializedHostedTool,
  providerData: Record<string, any>,
  credentialsFor: HostedToolCredentialsResolver
): Promise<SerializedHostedTool> {
  const serverLabel = providerData.server_label;
  if (typeof serverLabel !== 'string' || serverLabel === '') return tool;

  const credentials = await credentialsFor({
    tool: 'hostedMcp',
    name: tool.name,
    serverLabel,
    ...(typeof providerData.server_url === 'string' && { serverUrl: providerData.server_url }),
    ...(typeof providerData.connector_id === 'string' && { connectorId: providerData.connector_id }),
  });
  const authorization =
    providerData.authorization == null && typeof credentials?.authorization === 'string'
      ? credentials.authorization
      : undefined;
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
  credentialsFor: HostedToolCredentialsResolver
): Promise<SerializedHostedTool> {
  // `container` may be a bare container id string, which has no allowlist to key on.
  const container = providerData.container;
  if (!isRecord(container)) return tool;
  const policy = container.network_policy;
  if (!isRecord(policy) || policy.type !== 'allowlist' || !Array.isArray(policy.allowed_domains)) return tool;

  const credentials = await credentialsFor({
    tool: 'codeInterpreter',
    name: tool.name,
    allowedDomains: [...policy.allowed_domains],
  });
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
  credentialsFor: HostedToolCredentialsResolver
): Promise<SerializedShellTool> {
  // `local` and `container_reference` environments have no allowlist to key on.
  const environment = tool.environment;
  if (environment?.type !== 'container_auto') return tool;
  const policy = environment.networkPolicy;
  if (policy?.type !== 'allowlist' || !Array.isArray(policy.allowedDomains)) return tool;

  const credentials = await credentialsFor({
    tool: 'shell',
    name: tool.name,
    allowedDomains: [...policy.allowedDomains],
  });
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

async function injectTool(
  tool: SerializedTool,
  credentialsFor: HostedToolCredentialsResolver
): Promise<SerializedTool> {
  if (tool.type === 'shell') return injectShell(tool, credentialsFor);
  if (tool.type !== 'hosted_tool') return tool;
  const providerData = tool.providerData;
  if (providerData?.type === 'mcp') return injectHostedMcp(tool, providerData, credentialsFor);
  if (providerData?.type === 'code_interpreter') return injectCodeInterpreter(tool, providerData, credentialsFor);
  return tool;
}

/**
 * Clones each tool it fills in rather than writing into the Activity input.
 *
 * Nothing strips the credentials back out of the model response: what a model
 * provider echoes back is that provider's to redact, not this plugin's.
 */
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
