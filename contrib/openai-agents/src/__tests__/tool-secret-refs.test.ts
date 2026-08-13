import test from 'ava';
import {
  Usage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type SerializedTool,
} from '@openai/agents-core';
import type { Client } from '@temporalio/client';
import { ApplicationFailure, defaultPayloadConverter } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import { secretRef } from '../common/secret-ref';
import type { InvokeModelActivityInput, InvokeModelStreamActivityInput } from '../common/serialized-model';
import { createModelActivity } from '../worker/activities';
import { resolveToolSecretRefs } from '../worker/tool-secret-refs';
import { toSerializedModelRequest } from '../workflow/activity-backed-model';
import { streamingTextEvents } from './stubs/openai-agents-fakes';

const MCP_AUTH_VAR = 'OPENAI_AGENTS_TEST_MCP_AUTHORIZATION';
const MCP_HEADER_VAR = 'OPENAI_AGENTS_TEST_MCP_HEADER';
const SHELL_SECRET_VAR = 'OPENAI_AGENTS_TEST_SHELL_DOMAIN_SECRET';
const CODE_SECRET_VAR = 'OPENAI_AGENTS_TEST_CODE_DOMAIN_SECRET';

const CREDENTIALS: Record<string, string> = {
  [MCP_AUTH_VAR]: 'sk-mcp-authorization-sentinel',
  [MCP_HEADER_VAR]: 'sk-mcp-header-sentinel',
  [SHELL_SECRET_VAR]: 'sk-shell-domain-sentinel',
  [CODE_SECRET_VAR]: 'sk-code-interpreter-domain-sentinel',
};

/** Literals sharing a container with a reference — the headers map, each domain-secret array. */
const PLAIN_HEADER = 'plain-header-value';
const PLAIN_SHELL_SECRET = 'plain-shell-secret';
const PLAIN_CODE_SECRET = 'plain-code-secret';
const PLAIN_VALUES = [PLAIN_HEADER, PLAIN_SHELL_SECRET, PLAIN_CODE_SECRET];

/** The field label each reference must name when it cannot be resolved. */
const FAILURE_LABELS: Record<string, string> = {
  [MCP_AUTH_VAR]: "hosted MCP server 'docs' authorization",
  [MCP_HEADER_VAR]: "hosted MCP server 'docs' header 'X-Api-Key'",
  [SHELL_SECRET_VAR]: "shell tool domain secret 'REF_TOKEN'",
  [CODE_SECRET_VAR]: "code interpreter domain secret 'REF_TOKEN'",
};

const literal = (envVar: string): string => CREDENTIALS[envVar]!;

/** The four tool credential fields that cross into history, in their real wire shapes and casings. */
function credentialTools(value: (envVar: string) => string): SerializedTool[] {
  return [
    {
      type: 'hosted_tool',
      name: 'hosted_mcp',
      providerData: {
        type: 'mcp',
        server_label: 'docs',
        server_url: 'https://mcp.example.com',
        authorization: value(MCP_AUTH_VAR),
        headers: { 'X-Plain': PLAIN_HEADER, 'X-Api-Key': value(MCP_HEADER_VAR) },
      },
    },
    {
      type: 'shell',
      name: 'shell',
      environment: {
        type: 'container_auto',
        networkPolicy: {
          type: 'allowlist',
          allowedDomains: ['a.example.com', 'b.example.com'],
          domainSecrets: [
            { domain: 'a.example.com', name: 'PLAIN_TOKEN', value: PLAIN_SHELL_SECRET },
            { domain: 'b.example.com', name: 'REF_TOKEN', value: value(SHELL_SECRET_VAR) },
          ],
        },
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
          network_policy: {
            type: 'allowlist',
            allowed_domains: ['a.example.com', 'b.example.com'],
            domain_secrets: [
              { domain: 'a.example.com', name: 'PLAIN_TOKEN', value: PLAIN_CODE_SECRET },
              { domain: 'b.example.com', name: 'REF_TOKEN', value: value(CODE_SECRET_VAR) },
            ],
          },
        },
      },
    },
  ];
}

/** The referenced fields, ordered to match {@link CREDENTIALS}. */
function credentialValues(tools: SerializedTool[]): unknown[] {
  const [mcp, shell, code] = tools as any[];
  return [
    mcp.providerData.authorization,
    mcp.providerData.headers['X-Api-Key'],
    shell.environment.networkPolicy.domainSecrets[1].value,
    code.providerData.container.network_policy.domain_secrets[1].value,
  ];
}

/** The literal values, ordered to match {@link PLAIN_VALUES}. */
function plainValues(tools: SerializedTool[]): unknown[] {
  const [mcp, shell, code] = tools as any[];
  return [
    mcp.providerData.headers['X-Plain'],
    shell.environment.networkPolicy.domainSecrets[0].value,
    code.providerData.container.network_policy.domain_secrets[0].value,
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

function activityInput(value: (envVar: string) => string): InvokeModelActivityInput {
  return { modelName: 'gpt-5', request: toSerializedModelRequest(modelRequest(credentialTools(value))) };
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

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(vars);
  try {
    await fn();
  } finally {
    apply(previous);
  }
}

test('secretRef rejects a name that is empty or contains whitespace', (t) => {
  for (const name of ['', ' ', 'HAS SPACE', 'TRAILING\t', 'NEW\nLINE']) {
    const err = t.throws(() => secretRef(name), { instanceOf: ApplicationFailure }, JSON.stringify(name));
    t.is(err?.type, 'SecretReferenceNameError', JSON.stringify(name));
    t.true(err?.nonRetryable, JSON.stringify(name));
  }
  t.is(secretRef('OK_NAME'), 'temporal:secret-ref/OK_NAME');
});

test('tool credentials reach the Activity payload as literals, but as references when secretRef is used', (t) => {
  const literalPayload = payloadText(activityInput(literal));
  const referencePayload = payloadText(activityInput(secretRef));

  for (const [envVar, credential] of Object.entries(CREDENTIALS)) {
    t.true(literalPayload.includes(credential), `${envVar}: a literal credential does reach the payload`);
    t.false(referencePayload.includes(credential), `${envVar}: the credential must not reach the payload`);
    t.true(referencePayload.includes(secretRef(envVar)), `${envVar}: the reference must reach the payload`);
  }
});

test('tool shapes carrying no credentials are returned untouched, by identity', (t) => {
  const tools: SerializedTool[] = [
    { type: 'shell', name: 'shell', environment: { type: 'local' } },
    { type: 'shell', name: 'shell', environment: { type: 'container_reference', containerId: 'cntr_ref' } },
    { type: 'shell', name: 'shell', environment: { type: 'container_auto', networkPolicy: { type: 'disabled' } } },
    {
      type: 'shell',
      name: 'shell',
      environment: {
        type: 'container_auto',
        networkPolicy: { type: 'allowlist', allowedDomains: ['example.com'] },
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

  const resolved = resolveToolSecretRefs(tools);
  t.deepEqual(resolved, tools);
  resolved.forEach((tool, index) => t.is(tool, tools[index]!, `tool ${index} must not be cloned`));
});

test('a non-string credential value is passed through rather than crashing the Activity', (t) => {
  const tools = [
    {
      type: 'shell',
      name: 'shell',
      environment: {
        type: 'container_auto',
        networkPolicy: {
          type: 'allowlist',
          allowedDomains: ['example.com'],
          domainSecrets: [{ domain: 'example.com', name: 'BROKEN' }],
        },
      },
    },
    {
      type: 'hosted_tool',
      name: 'code_interpreter',
      providerData: {
        type: 'code_interpreter',
        container: {
          type: 'auto',
          network_policy: { type: 'allowlist', allowed_domains: ['example.com'], domain_secrets: [{ value: 42 }] },
        },
      },
    },
    { type: 'hosted_tool', name: 'hosted_mcp', providerData: { type: 'mcp', server_label: 'x', headers: { A: 7 } } },
  ] as unknown as SerializedTool[];

  t.notThrows(() => resolveToolSecretRefs(tools));

  const [shell, code, mcp] = resolveToolSecretRefs(tools) as any[];
  t.deepEqual(shell.environment.networkPolicy.domainSecrets[0], { domain: 'example.com', name: 'BROKEN' });
  t.is(code.providerData.container.network_policy.domain_secrets[0].value, 42);
  t.is(mcp.providerData.headers.A, 7);
});

test.serial(
  'invokeModelActivity resolves references from the Worker environment without mutating its input',
  async (t) => {
    const input = roundTrip(activityInput(secretRef));
    const captured: ModelRequest[] = [];
    const { invokeModelActivity } = createModelActivity(capturingProvider(captured));

    await withEnv(CREDENTIALS, async () => {
      await new MockActivityEnvironment().run(invokeModelActivity, input);
    });

    t.deepEqual(credentialValues(captured[0]!.tools), Object.values(CREDENTIALS));
    t.deepEqual(plainValues(captured[0]!.tools), PLAIN_VALUES);
    t.deepEqual(credentialValues(input.request.tools), Object.keys(CREDENTIALS).map(secretRef));
    t.deepEqual(plainValues(input.request.tools), PLAIN_VALUES);
  }
);

test.serial('invokeModelStreamActivity resolves references through the same injection point', async (t) => {
  const input: InvokeModelStreamActivityInput = { ...roundTrip(activityInput(secretRef)), streamingTopic: 'events' };
  const captured: ModelRequest[] = [];
  const { invokeModelStreamActivity } = createModelActivity(capturingProvider(captured));

  await withEnv(CREDENTIALS, async () => {
    await new MockActivityEnvironment(undefined, { client: discardingClient() }).run(invokeModelStreamActivity, input);
  });

  t.deepEqual(credentialValues(captured[0]!.tools), Object.values(CREDENTIALS));
  t.deepEqual(plainValues(captured[0]!.tools), PLAIN_VALUES);
  t.deepEqual(credentialValues(input.request.tools), Object.keys(CREDENTIALS).map(secretRef));
});

test.serial('an unset or empty Worker environment variable fails both model Activities non-retryably', async (t) => {
  for (const [envVar, fieldLabel] of Object.entries(FAILURE_LABELS)) {
    for (const [state, override] of [
      ['unset', undefined],
      ['empty', ''],
    ] as Array<[string, string | undefined]>) {
      const { invokeModelActivity, invokeModelStreamActivity } = createModelActivity(capturingProvider([]));
      const input = roundTrip(activityInput(secretRef));
      const streamInput: InvokeModelStreamActivityInput = { ...input, streamingTopic: 'events' };

      await withEnv({ ...CREDENTIALS, [envVar]: override }, async () => {
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
          const context = `${activity} / ${envVar} / ${state}`;
          const err = await t.throwsAsync(run(), { instanceOf: ApplicationFailure }, context);
          t.is(err?.type, 'SecretReferenceError', context);
          t.true(err?.nonRetryable, context);
          t.true(err!.message.includes(fieldLabel), context);
          t.true(err!.message.includes(envVar), context);
          t.true(err!.message.includes(override === undefined ? 'not set' : 'empty'), context);
          t.false(err!.message.includes(CREDENTIALS[envVar]!), context);
        }
      });
    }
  }
});

test.serial('a hosted MCP tool with no server label omits the label rather than inventing one', async (t) => {
  const tools: SerializedTool[] = [
    { type: 'hosted_tool', name: 'hosted_mcp', providerData: { type: 'mcp', authorization: secretRef(MCP_AUTH_VAR) } },
  ];

  await withEnv({ [MCP_AUTH_VAR]: undefined }, async () => {
    const err = t.throws(() => resolveToolSecretRefs(tools), { instanceOf: ApplicationFailure });
    t.is(err?.type, 'SecretReferenceError');
    t.true(err!.message.includes('hosted MCP server authorization'));
    t.false(err!.message.includes('undefined'));
    // `tool.name` is the constant 'hosted_mcp' for every hosted MCP tool, so it is not a label.
    t.false(err!.message.includes('hosted_mcp'));
  });
});

test('an array-valued headers field is not rewritten into an index-keyed object', (t) => {
  const tools = [
    { type: 'hosted_tool', name: 'hosted_mcp', providerData: { type: 'mcp', server_label: 'docs', headers: ['a'] } },
  ] as unknown as SerializedTool[];

  const [resolved] = resolveToolSecretRefs(tools) as any[];
  t.deepEqual(resolved.providerData.headers, ['a']);
});

test('a marker outside the four credential fields is passed through verbatim', (t) => {
  const marker = secretRef('OPENAI_AGENTS_TEST_NEVER_SET');
  const tools: SerializedTool[] = [
    {
      type: 'hosted_tool',
      name: 'hosted_mcp',
      providerData: { type: 'mcp', server_label: 'docs', server_url: marker, authorization: 'literal-token' },
    },
  ];

  const [resolved] = resolveToolSecretRefs(tools) as any[];
  t.is(resolved.providerData.server_url, marker);
  t.is(resolved.providerData.authorization, 'literal-token');
});
