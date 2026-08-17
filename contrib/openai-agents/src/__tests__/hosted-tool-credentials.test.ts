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

test('a declared headers value that is not an object is left alone rather than spread character-wise', async (t) => {
  const tools = hostedTools() as any[];
  tools[0].providerData.headers = 'oops';

  const [mcp] = (await injectHostedToolCredentials(tools as SerializedTool[], workerCredentials)) as any[];

  t.is(mcp.providerData.headers, 'oops');
  t.is(mcp.providerData.authorization, MCP_AUTH);
});

test('a callback that supplies a header or authorization in the wrong shape fails non-retryably', async (t) => {
  const cases: Array<[string, unknown, string]> = [
    ['a return that is not an object', MCP_AUTH, 'expected an object, got a string'],
    ['an authorization that is not a string', { authorization: 1 }, "'authorization' must be a string, got a number"],
    ['a headers map that is not an object', { headers: MCP_HEADER }, "'headers' must be an object, got a string"],
    [
      'a header value that is not a string',
      { headers: { 'X-Api-Key': [MCP_HEADER] } },
      "'headers' entry 'X-Api-Key' must be a string, got an array",
    ],
  ];

  for (const [label, credentials, problem] of cases) {
    const err = await t.throwsAsync(
      injectHostedToolCredentials([hostedTools()[0]!], () => credentials as HostedToolCredentials),
      { instanceOf: ApplicationFailure },
      label
    );

    t.is(err?.type, 'HostedToolCredentialsShapeError', label);
    t.true(err?.nonRetryable, label);
    t.is(
      err!.message,
      "Cannot use the credentials resolved for hosted MCP tool 'hosted_mcp' " +
        `(server label 'docs', https://mcp.example.com): ${problem}.`,
      label
    );
    for (const credential of CREDENTIAL_VALUES) t.false(err!.message.includes(credential), label);
  }
});

test('a callback that supplies domain secrets in the wrong shape fails non-retryably', async (t) => {
  const cases: Array<[string, unknown, string]> = [
    ['a list that is not an array', { domainSecrets: SHELL_SECRET }, "'domainSecrets' must be an array, got a string"],
    [
      'an entry that is not an object',
      { domainSecrets: [null] },
      "'domainSecrets' entry 0 must be an object, got null",
    ],
    [
      'an entry with no domain',
      { domainSecrets: [{ name: 'SHELL_TOKEN', value: SHELL_SECRET }] },
      "'domainSecrets' entry 0 must have a string 'domain', got undefined",
    ],
    [
      'an entry with no value',
      { domainSecrets: [{ domain: 'b.example.com', name: 'SHELL_TOKEN' }] },
      "'domainSecrets' entry 0 must have a string 'value', got undefined",
    ],
  ];

  for (const [label, credentials, problem] of cases) {
    const err = await t.throwsAsync(
      injectHostedToolCredentials([hostedTools()[1]!], () => credentials as HostedToolCredentials),
      { instanceOf: ApplicationFailure },
      label
    );

    t.is(err?.type, 'HostedToolCredentialsShapeError', label);
    t.true(err?.nonRetryable, label);
    t.is(
      err!.message,
      "Cannot use the credentials resolved for shell tool 'shell' allowing a.example.com, b.example.com: " +
        `${problem}.`,
      label
    );
    for (const credential of CREDENTIAL_VALUES) t.false(err!.message.includes(credential), label);
  }
});

test('a callback returning null for a credential field leaves the tool as declared rather than failing', async (t) => {
  const tools = hostedTools();

  const injected = await injectHostedToolCredentials(
    tools,
    () => ({ authorization: null, headers: null, domainSecrets: null }) as unknown as HostedToolCredentials
  );

  t.deepEqual(injected, tools);
});

test('a malformed callback return fails the model Activity non-retryably rather than as a raw TypeError', async (t) => {
  const input = roundTrip(activityInput([hostedTools()[1]!]));
  const { invokeModelActivity } = createModelActivity(
    capturingProvider([]),
    () => ({ domainSecrets: SHELL_SECRET }) as unknown as HostedToolCredentials
  );

  const err = await t.throwsAsync(new MockActivityEnvironment().run(invokeModelActivity, input), {
    instanceOf: ApplicationFailure,
  });

  t.is(err?.type, 'HostedToolCredentialsShapeError');
  t.true(err?.nonRetryable);
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

test('a callback that rejects fails both model Activities non-retryably, naming the tool', async (t) => {
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
    const err = await t.throwsAsync(run(), { instanceOf: ApplicationFailure }, activity);
    t.is(err?.type, 'HostedToolCredentialsError', activity);
    t.true(err?.nonRetryable, activity);
    t.is(
      err!.message,
      "Cannot resolve credentials for hosted MCP tool 'hosted_mcp' (server label 'docs', https://mcp.example.com).",
      activity
    );
    for (const credential of CREDENTIAL_VALUES) t.false(err!.message.includes(credential), activity);
    t.is((err?.cause as Error | undefined)?.message, 'secret manager unavailable', activity);
  }
});

test('a shell callback failure names the tool and the domains it allows', async (t) => {
  const err = await t.throwsAsync(
    injectHostedToolCredentials([hostedTools()[1]!], () => {
      throw new Error('unavailable');
    }),
    { instanceOf: ApplicationFailure }
  );

  t.is(err?.type, 'HostedToolCredentialsError');
  t.is(err!.message, "Cannot resolve credentials for shell tool 'shell' allowing a.example.com, b.example.com.");
});

test('a shell tool that allows no domains is named without a dangling allowlist clause', async (t) => {
  const tool: SerializedTool = {
    type: 'shell',
    name: 'shell',
    environment: { type: 'container_auto', networkPolicy: { type: 'allowlist', allowedDomains: [] } },
  };

  const err = await t.throwsAsync(
    injectHostedToolCredentials([tool], () => {
      throw new Error('unavailable');
    }),
    { instanceOf: ApplicationFailure }
  );

  t.is(err!.message, "Cannot resolve credentials for shell tool 'shell'.");
});

test('a hosted MCP tool built with neither a server URL nor a connector id is still named', async (t) => {
  const tool = serializeHostedTool(hostedMcpTool({ serverLabel: 'docs' }));

  const err = await t.throwsAsync(
    injectHostedToolCredentials([tool], () => {
      throw new Error('unavailable');
    }),
    { instanceOf: ApplicationFailure }
  );

  t.is(
    err!.message,
    "Cannot resolve credentials for hosted MCP tool 'hosted_mcp' (server label 'docs', no server url or connector id)."
  );
});

test('an ApplicationFailure from the callback reaches the caller with its own retryability', async (t) => {
  const failing: HostedToolCredentialsResolver = async () => {
    throw ApplicationFailure.create({ message: 'secret manager unavailable', type: 'SecretManagerUnavailable' });
  };

  const err = await t.throwsAsync(injectHostedToolCredentials(hostedTools(), failing), {
    instanceOf: ApplicationFailure,
  });

  t.is(err?.type, 'SecretManagerUnavailable');
  t.falsy(err?.nonRetryable);
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
