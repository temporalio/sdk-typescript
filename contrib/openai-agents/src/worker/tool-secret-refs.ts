import type { SerializedTool } from '@openai/agents-core';
import { resolveWorkerEnvSecret, secretRefName } from '../common/secret-ref';

type SerializedShellTool = Extract<SerializedTool, { type: 'shell' }>;
type SerializedHostedTool = Extract<SerializedTool, { type: 'hosted_tool' }>;

type WireDomainSecret = { name?: unknown; value?: unknown };

function resolve(value: unknown, field: string): unknown {
  if (typeof value !== 'string') return value;
  const name = secretRefName(value);
  if (name === undefined) return value;
  return resolveWorkerEnvSecret(name, field);
}

function resolveHostedMcpTool(tool: SerializedHostedTool, providerData: Record<string, any>): SerializedHostedTool {
  const { authorization, headers, server_label: serverLabel } = providerData;
  const hasHeaders = headers !== null && typeof headers === 'object' && !Array.isArray(headers);
  if (typeof authorization !== 'string' && !hasHeaders) return tool;
  const label =
    typeof serverLabel === 'string' && serverLabel !== '' ? `hosted MCP server '${serverLabel}'` : 'hosted MCP server';

  const resolved: Record<string, any> = { ...providerData };
  if (typeof authorization === 'string') {
    resolved.authorization = resolve(authorization, `${label} authorization`);
  }
  if (hasHeaders) {
    resolved.headers = Object.fromEntries(
      Object.entries(headers as Record<string, unknown>).map(([key, value]) => [
        key,
        resolve(value, `${label} header '${key}'`),
      ])
    );
  }
  return { ...tool, providerData: resolved };
}

function resolveCodeInterpreterTool(
  tool: SerializedHostedTool,
  providerData: Record<string, any>
): SerializedHostedTool {
  // `container` may be a bare container id string, which carries no secrets.
  const container = providerData.container;
  if (container === null || typeof container !== 'object') return tool;
  const policy = container.network_policy;
  if (policy?.type !== 'allowlist' || !Array.isArray(policy.domain_secrets)) return tool;

  return {
    ...tool,
    providerData: {
      ...providerData,
      container: {
        ...container,
        network_policy: {
          ...policy,
          domain_secrets: policy.domain_secrets.map((secret: WireDomainSecret) => {
            const value = resolve(secret.value, `code interpreter domain secret '${secret.name}'`);
            return typeof value === 'string' ? { ...secret, value } : secret;
          }),
        },
      },
    },
  };
}

function resolveShellTool(tool: SerializedShellTool): SerializedShellTool {
  // `local` and `container_reference` environments carry no domain secrets.
  const environment = tool.environment;
  if (environment?.type !== 'container_auto') return tool;
  const policy = environment.networkPolicy;
  if (policy?.type !== 'allowlist' || !Array.isArray(policy.domainSecrets)) return tool;

  return {
    ...tool,
    environment: {
      ...environment,
      networkPolicy: {
        ...policy,
        domainSecrets: policy.domainSecrets.map((secret) => {
          const value = resolve(secret.value, `shell tool domain secret '${secret.name}'`);
          return typeof value === 'string' ? { ...secret, value } : secret;
        }),
      },
    },
  };
}

/** Clones each affected tool rather than writing into the Activity input. */
export function resolveToolSecretRefs(tools: SerializedTool[]): SerializedTool[] {
  return tools.map((tool) => {
    if (tool.type === 'shell') return resolveShellTool(tool);
    if (tool.type !== 'hosted_tool') return tool;
    const providerData = tool.providerData;
    if (providerData?.type === 'mcp') return resolveHostedMcpTool(tool, providerData);
    if (providerData?.type === 'code_interpreter') return resolveCodeInterpreterTool(tool, providerData);
    return tool;
  });
}
