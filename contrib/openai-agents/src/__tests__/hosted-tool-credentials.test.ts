import test from 'ava';
import {
  Usage,
  hostedMcpTool,
  type HostedMCPTool,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type SerializedTool,
} from '@openai/agents-core';
import type { Client } from '@temporalio/client';
import { ApplicationFailure, defaultPayloadConverter } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import type { WorkerOptions } from '@temporalio/worker';
import type { InvokeModelActivityInput, InvokeModelStreamActivityInput } from '../common/serialized-model';
import { createModelActivity } from '../worker/activities';
import {
  injectHostedToolCredentials,
  type HostedToolCredentials,
  type HostedToolCredentialsResolver,
  type HostedToolIdentity,
} from '../worker/hosted-tool-credentials';
import { OpenAIAgentsPlugin } from '../worker/plugin';
import { toSerializedModelRequest } from '../workflow/activity-backed-model';
import { streamingTextEvents } from './stubs/openai-agents-fakes';

const MCP_AUTH = 'sk-mcp-authorization-sentinel';
const MCP_HEADER = 'sk-mcp-header-sentinel';
const SHELL_SECRET = 'sk-shell-domain-sentinel';
const CODE_SECRET = 'sk-code-interpreter-domain-sentinel';
const CREDENTIAL_VALUES = [MCP_AUTH, MCP_HEADER, SHELL_SECRET, CODE_SECRET];

const ALLOWED_DOMAINS = ['a.example.com', 'b.example.com'];

/** The credentials a Worker supplies, keyed by the identity it is asked about. */
const workerCredentials: HostedToolCredentialsResolver = (identity) => {
  switch (identity.tool) {
    case 'hostedMcp':
      return { authorization: MCP_AUTH, headers: { 'X-Api-Key': MCP_HEADER } };
    case 'shell':
      return { domainSecrets: [{ domain: 'b.example.com', name: 'SHELL_TOKEN', value: SHELL_SECRET }] };
    case 'codeInterpreter':
      return { domainSecrets: [{ domain: 'b.example.com', name: 'CODE_TOKEN', value: CODE_SECRET }] };
  }
};

/** The three hosted tool kinds as Workflow code declares them: identity only, no credentials. */
function hostedTools(): SerializedTool[] {
  return [
    {
      type: 'hosted_tool',
      name: 'hosted_mcp',
      providerData: {
        type: 'mcp',
        server_label: 'docs',
        server_url: 'https://mcp.example.com',
        require_approval: 'never',
      },
    },
    {
      type: 'shell',
      name: 'shell',
      environment: {
        type: 'container_auto',
        networkPolicy: { type: 'allowlist', allowedDomains: [...ALLOWED_DOMAINS] },
      },
    },
    {
      type: 'hosted_tool',
      name: 'code_interpreter',
      providerData: {
        type: 'code_interpreter',
        name: 'code_interpreter',
        container: {
          type: 'auto',
          network_policy: { type: 'allowlist', allowed_domains: [...ALLOWED_DOMAINS] },
        },
      },
    },
  ];
}

/** What the agents SDK's own `serializeTool` emits for a hosted tool; it is not exported. */
function serializeHostedTool(tool: HostedMCPTool): SerializedTool {
  return { type: 'hosted_tool', name: tool.name, providerData: tool.providerData };
}

/** The credential-bearing fields of {@link hostedTools}, ordered to match {@link CREDENTIAL_VALUES}. */
function credentialValues(tools: SerializedTool[]): unknown[] {
  const [mcp, shell, code] = tools as any[];
  return [
    mcp.providerData.authorization,
    mcp.providerData.headers?.['X-Api-Key'],
    shell.environment.networkPolicy.domainSecrets?.[0]?.value,
    code.providerData.container.network_policy.domain_secrets?.[0]?.value,
  ];
}

function modelRequest(tools: SerializedTool[]): ModelRequest {
  return {
    input: 'hi',
    modelSettings: {},
    tools,
    toolsExplicitlyProvided: true,
    outputType: 'text',
    handoffs: [],
    tracing: false,
  } as unknown as ModelRequest;
}

function activityInput(tools: SerializedTool[]): InvokeModelActivityInput {
  return { modelName: 'gpt-5', request: toSerializedModelRequest(modelRequest(tools)) };
}

function payloadText(input: unknown): string {
  return Buffer.from(defaultPayloadConverter.toPayload(input)!.data!).toString('utf8');
}

function roundTrip<T>(input: T): T {
  return defaultPayloadConverter.fromPayload<T>(defaultPayloadConverter.toPayload(input)!);
}

function capturingProvider(captured: ModelRequest[]): ModelProvider {
  const response: ModelResponse = { usage: new Usage(), output: [], responseId: 'resp-1' };
  return {
    getModel: () => ({
      async getResponse(request: ModelRequest) {
        captured.push(request);
        return response;
      },
      async *getStreamedResponse(request: ModelRequest) {
        captured.push(request);
        for (const event of streamingTextEvents('ok')) yield event;
      },
    }),
  };
}

/** The stream publisher needs a Client; this one discards everything it publishes. */
function discardingClient(): Client {
  return {
    withAbortSignal: <R>(_signal: AbortSignal, fn: () => Promise<R>) => fn(),
    workflow: {
      getHandle: () => ({ async signal() {} }),
    },
  } as unknown as Client;
}

test('the Activity argument carries the tool identity and none of the credentials', (t) => {
  const payload = payloadText(activityInput(hostedTools()));

  for (const credential of CREDENTIAL_VALUES) {
    t.false(payload.includes(credential), `${credential} must not reach the payload`);
  }
  t.true(payload.includes('docs'));
  for (const domain of ALLOWED_DOMAINS) t.true(payload.includes(domain));
});

test('a credential declared in Workflow code does reach the Activity argument', (t) => {
  const tools = hostedTools() as any[];
  tools[0].providerData.authorization = MCP_AUTH;
  const payload = payloadText(activityInput(tools as SerializedTool[]));

  t.true(payload.includes(MCP_AUTH));
});

test('the callback is asked about each hosted tool by its non-secret identity', async (t) => {
  const identities: HostedToolIdentity[] = [];
  await injectHostedToolCredentials(hostedTools(), (identity) => {
    identities.push(identity);
    return undefined;
  });

  t.deepEqual(identities, [
    { tool: 'hostedMcp', name: 'hosted_mcp', serverLabel: 'docs', serverUrl: 'https://mcp.example.com' },
    { tool: 'shell', name: 'shell', allowedDomains: ALLOWED_DOMAINS },
    { tool: 'codeInterpreter', name: 'code_interpreter', allowedDomains: ALLOWED_DOMAINS },
  ]);
});

test('two hosted MCP tools are told apart by their server, since the constructor names them all alike', async (t) => {
  const tools = roundTrip([
    serializeHostedTool(hostedMcpTool({ serverLabel: 'docs', serverUrl: 'https://primary.example.com' })),
    serializeHostedTool(hostedMcpTool({ serverLabel: 'docs', connectorId: 'connector_dropbox' })),
  ]);

  const identities: HostedToolIdentity[] = [];
  const injected = (await injectHostedToolCredentials(tools, (identity) => {
    identities.push(identity);
    const target = identity.tool === 'hostedMcp' ? identity.serverUrl ?? identity.connectorId : undefined;
    return { authorization: `authorization-for-${target}` };
  })) as any[];

  t.deepEqual(identities, [
    { tool: 'hostedMcp', name: 'hosted_mcp', serverLabel: 'docs', serverUrl: 'https://primary.example.com' },
    { tool: 'hostedMcp', name: 'hosted_mcp', serverLabel: 'docs', connectorId: 'connector_dropbox' },
  ]);
  t.is(injected[0].providerData.authorization, 'authorization-for-https://primary.example.com');
  t.is(injected[1].providerData.authorization, 'authorization-for-connector_dropbox');
});

test('a callback that supplies nothing leaves every tool exactly as declared', async (t) => {
  const tools = hostedTools();
  const injected = await injectHostedToolCredentials(tools, () => undefined);

  t.deepEqual(injected, tools);
});

test('no configured callback leaves the tools the Activity received untouched', async (t) => {
  const input = roundTrip(activityInput(hostedTools()));
  const captured: ModelRequest[] = [];
  const { invokeModelActivity } = createModelActivity(capturingProvider(captured));

  await new MockActivityEnvironment().run(invokeModelActivity, input);

  t.deepEqual(captured[0]!.tools, input.request.tools);
});

test('invokeModelActivity hands the provider the resolved credentials without mutating its input', async (t) => {
  const input = roundTrip(activityInput(hostedTools()));
  const captured: ModelRequest[] = [];
  const { invokeModelActivity } = createModelActivity(capturingProvider(captured), workerCredentials);

  await new MockActivityEnvironment().run(invokeModelActivity, input);

  t.deepEqual(credentialValues(captured[0]!.tools), CREDENTIAL_VALUES);
  t.deepEqual(credentialValues(input.request.tools), [undefined, undefined, undefined, undefined]);
});

test('invokeModelStreamActivity resolves credentials through the same injection point', async (t) => {
  const input: InvokeModelStreamActivityInput = {
    ...roundTrip(activityInput(hostedTools())),
    streamingTopic: 'events',
  };
  const captured: ModelRequest[] = [];
  const { invokeModelStreamActivity } = createModelActivity(capturingProvider(captured), workerCredentials);

  await new MockActivityEnvironment(undefined, { client: discardingClient() }).run(invokeModelStreamActivity, input);

  t.deepEqual(credentialValues(captured[0]!.tools), CREDENTIAL_VALUES);
  t.deepEqual(credentialValues(input.request.tools), [undefined, undefined, undefined, undefined]);
});

test('a credential declared in Workflow code wins over the one the callback supplies', async (t) => {
  const tools = hostedTools() as any[];
  tools[0].providerData.authorization = 'declared-authorization';
  tools[0].providerData.headers = { 'X-Api-Key': 'declared-key' };
  tools[1].environment.networkPolicy.domainSecrets = [
    { domain: 'b.example.com', name: 'SHELL_TOKEN', value: 'declared-shell-secret' },
  ];
  tools[2].providerData.container.network_policy.domain_secrets = [
    { domain: 'b.example.com', name: 'CODE_TOKEN', value: 'declared-code-secret' },
  ];

  const injected = (await injectHostedToolCredentials(tools as SerializedTool[], workerCredentials)) as any[];

  t.deepEqual(credentialValues(injected as SerializedTool[]), [
    'declared-authorization',
    'declared-key',
    'declared-shell-secret',
    'declared-code-secret',
  ]);
});

test('a whole credential field the Workflow left as null is filled in rather than treated as declared', async (t) => {
  const tools = hostedTools() as any[];
  tools[0].providerData.authorization = null;
  tools[0].providerData.headers = null;
  tools[1].environment.networkPolicy.domainSecrets = null;
  tools[2].providerData.container.network_policy.domain_secrets = null;

  const injected = await injectHostedToolCredentials(tools as SerializedTool[], workerCredentials);

  t.deepEqual(credentialValues(injected), CREDENTIAL_VALUES);
});

test('one entry left as null inside an otherwise declared headers map or secrets list is filled in too', async (t) => {
  const tools = hostedTools() as any[];
  tools[0].providerData.headers = { 'X-Trace': 'declared-trace', 'X-Api-Key': null };
  tools[1].environment.networkPolicy.domainSecrets = [
    { domain: 'a.example.com', name: 'OTHER_TOKEN', value: 'declared-shell-secret' },
    { domain: 'b.example.com', name: 'SHELL_TOKEN', value: null },
  ];
  tools[2].providerData.container.network_policy.domain_secrets = [
    { domain: 'a.example.com', name: 'OTHER_TOKEN', value: 'declared-code-secret' },
    { domain: 'b.example.com', name: 'CODE_TOKEN', value: null },
  ];

  const injected = (await injectHostedToolCredentials(tools as SerializedTool[], workerCredentials)) as any[];

  t.deepEqual(injected[0].providerData.headers, { 'X-Trace': 'declared-trace', 'X-Api-Key': MCP_HEADER });
  t.deepEqual(injected[1].environment.networkPolicy.domainSecrets, [
    { domain: 'a.example.com', name: 'OTHER_TOKEN', value: 'declared-shell-secret' },
    { domain: 'b.example.com', name: 'SHELL_TOKEN', value: SHELL_SECRET },
  ]);
  t.deepEqual(injected[2].providerData.container.network_policy.domain_secrets, [
    { domain: 'a.example.com', name: 'OTHER_TOKEN', value: 'declared-code-secret' },
    { domain: 'b.example.com', name: 'CODE_TOKEN', value: CODE_SECRET },
  ]);
});

test('a credential the callback supplies is added alongside the ones declared in Workflow code', async (t) => {
  const tools = hostedTools() as any[];
  tools[0].providerData.headers = { 'X-Trace': 'declared-trace' };
  tools[1].environment.networkPolicy.domainSecrets = [
    { domain: 'a.example.com', name: 'OTHER_TOKEN', value: 'declared-shell-secret' },
  ];

  const [mcp, shell] = (await injectHostedToolCredentials(tools as SerializedTool[], workerCredentials)) as any[];

  t.deepEqual(mcp.providerData.headers, { 'X-Trace': 'declared-trace', 'X-Api-Key': MCP_HEADER });
  t.deepEqual(shell.environment.networkPolicy.domainSecrets, [
    { domain: 'a.example.com', name: 'OTHER_TOKEN', value: 'declared-shell-secret' },
    { domain: 'b.example.com', name: 'SHELL_TOKEN', value: SHELL_SECRET },
  ]);
});

test('tool shapes with nowhere to put a credential are returned untouched, by identity', async (t) => {
  const tools: SerializedTool[] = [
    { type: 'shell', name: 'shell', environment: { type: 'local' } },
    { type: 'shell', name: 'shell', environment: { type: 'container_reference', containerId: 'cntr_ref' } },
    { type: 'shell', name: 'shell', environment: { type: 'container_auto', networkPolicy: { type: 'disabled' } } },
    { type: 'shell', name: 'shell', environment: { type: 'container_auto' } },
    {
      type: 'shell',
      name: 'shell',
      environment: { type: 'container_auto', networkPolicy: { type: 'allowlist' } },
    } as unknown as SerializedTool,
    {
      type: 'hosted_tool',
      name: 'code_interpreter',
      providerData: {
        type: 'code_interpreter',
        container: { type: 'auto', network_policy: { type: 'allowlist', allowed_domains: 'a.example.com' } },
      },
    },
    {
      type: 'hosted_tool',
      name: 'code_interpreter',
      providerData: { type: 'code_interpreter', container: 'cntr_abc' },
    },
    {
      type: 'hosted_tool',
      name: 'code_interpreter',
      providerData: { type: 'code_interpreter', container: { type: 'auto' } },
    },
    {
      type: 'hosted_tool',
      name: 'code_interpreter',
      providerData: { type: 'code_interpreter', container: null },
    },
    { type: 'hosted_tool', name: 'hosted_mcp', providerData: { type: 'mcp', server_url: 'https://mcp.example.com' } },
    { type: 'hosted_tool', name: 'web_search', providerData: { type: 'web_search' } },
    { type: 'hosted_tool', name: 'no_provider_data' },
    {
      type: 'function',
      name: 'fn',
      description: 'd',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      strict: true,
    },
  ];

  const identities: HostedToolIdentity[] = [];
  const injected = await injectHostedToolCredentials(tools, (identity) => {
    identities.push(identity);
    return workerCredentials(identity) as HostedToolCredentials;
  });

  t.deepEqual(identities, []);
  t.deepEqual(injected, tools);
});

test('a callback that rejects fails both model Activities with its own error', async (t) => {
  const failing: HostedToolCredentialsResolver = async () => {
    throw new Error('secret manager unavailable');
  };
  const input = roundTrip(activityInput(hostedTools()));
  const streamInput: InvokeModelStreamActivityInput = { ...input, streamingTopic: 'events' };
  const { invokeModelActivity, invokeModelStreamActivity } = createModelActivity(capturingProvider([]), failing);

  for (const [activity, run] of [
    ['invokeModelActivity', () => new MockActivityEnvironment().run(invokeModelActivity, input)],
    [
      'invokeModelStreamActivity',
      () =>
        new MockActivityEnvironment(undefined, { client: discardingClient() }).run(
          invokeModelStreamActivity,
          streamInput
        ),
    ],
  ] as Array<[string, () => Promise<unknown>]>) {
    // A transient secret-manager outage stays retryable, so rewrapping it would be wrong.
    const err = await t.throwsAsync(run(), undefined, activity);
    t.false(err instanceof ApplicationFailure, activity);
    t.is(err?.message, 'secret manager unavailable', activity);
  }
});

test('the plugin passes its hostedToolCredentials to the model Activity it registers', async (t) => {
  const captured: ModelRequest[] = [];
  const plugin = new OpenAIAgentsPlugin({
    modelProvider: capturingProvider(captured),
    hostedToolCredentials: workerCredentials,
  });
  const { activities } = plugin.configureWorker({ taskQueue: 'test' } as WorkerOptions);
  const invokeModelActivity = (activities as Record<string, (input: InvokeModelActivityInput) => Promise<unknown>>)
    .invokeModelActivity!;

  await new MockActivityEnvironment().run(invokeModelActivity, roundTrip(activityInput(hostedTools())));

  t.deepEqual(credentialValues(captured[0]!.tools), CREDENTIAL_VALUES);
});

test('the heartbeat is already running when the callback is asked for credentials', async (t) => {
  // A callback that reads a secret manager can outlast the heartbeat timeout, so
  // the Activity must have heartbeat before it is awaited.
  const env = new MockActivityEnvironment({ heartbeatTimeoutMs: 200 });
  let heartbeats = 0;
  env.on('heartbeat', () => {
    heartbeats += 1;
  });

  let heartbeatsWhenAsked = -1;
  const { invokeModelActivity } = createModelActivity(capturingProvider([]), async () => {
    heartbeatsWhenAsked = heartbeats;
    return undefined;
  });
  await env.run(invokeModelActivity, roundTrip(activityInput(hostedTools())));

  t.is(heartbeatsWhenAsked, 1);
});

test.serial('a credential for a field the Workflow already declared is never read', async (t) => {
  const tools = hostedTools() as any[];
  tools[0].providerData.authorization = 'declared-authorization';

  const [mcp] = (await injectHostedToolCredentials(tools as SerializedTool[], () => ({
    authorization: 42 as unknown as string,
  }))) as any[];

  t.is(mcp.providerData.authorization, 'declared-authorization');
});
