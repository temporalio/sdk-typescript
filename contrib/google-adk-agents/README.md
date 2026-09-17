# @temporalio/google-adk-agents

Run [Google Agent Development Kit](https://github.com/google/adk-js) (`@google/adk`)
agents as durable [Temporal](https://temporal.io) Workflows.

Your ADK agent graph runs inside the Workflow and replays deterministically. The
plugin routes non-deterministic boundaries out to Activities:

- every **model call** (`generateContentAsync`) becomes a retryable, observable
  Activity, and
- every **MCP tool call** (list-tools / call-tool) becomes an Activity.

Regular ADK `FunctionTool`s still run in the Workflow. If a tool performs I/O,
wrap an existing Temporal Activity with `activityAsTool`.

## Install

```bash
npm install @temporalio/google-adk-agents @google/adk @google/genai
```

The supported peer range is `@google/adk` `>=1.5.0 <1.6.0` and `@google/genai`
`^2.9.0`. The ceiling is exact by design: the plugin's Workflow-sandbox shims are
keyed to what ADK reaches at module load, so an ADK minor outside this range can
break the Workflow bundle.

Provide Gemini credentials to the Worker as usual, for example with
`GOOGLE_GENAI_API_KEY` or `GEMINI_API_KEY`.

## Hello world

Wrap the agent model in `TemporalModel`, then register `GoogleAdkPlugin` on the
Worker.

### `workflows.ts`

```typescript
import { InMemoryRunner, LlmAgent, isFinalResponse, stringifyContent } from '@google/adk';
import { TemporalModel } from '@temporalio/google-adk-agents/workflow';

export async function askAgent(prompt: string): Promise<string> {
  const agent = new LlmAgent({
    name: 'assistant',
    // The only change from a vanilla ADK agent:
    model: new TemporalModel('gemini-2.5-flash'),
    instruction: 'You are a helpful assistant.',
  });

  const runner = new InMemoryRunner({ agent });

  let text = '';
  for await (const event of runner.runEphemeral({
    userId: 'user',
    newMessage: { role: 'user', parts: [{ text: prompt }] },
  })) {
    if (isFinalResponse(event)) text = stringifyContent(event);
  }
  return text;
}
```

### `worker.ts`

```typescript
import { Worker } from '@temporalio/worker';
import { GoogleAdkPlugin } from '@temporalio/google-adk-agents';

const worker = await Worker.create({
  taskQueue: 'adk',
  workflowsPath: require.resolve('./workflows'),
  // Register the plugin on the Worker. This installs the model Activities and
  // the Workflow bundler configuration required by @google/adk.
  plugins: [new GoogleAdkPlugin()],
});
await worker.run();
```

### `client.ts`

```typescript
import { Client } from '@temporalio/client';
import { askAgent } from './workflows';

// No plugin is needed on the Client for this package. The Worker registration
// above is what makes TemporalModel calls execute as Activities.
const client = new Client();

const result = await client.workflow.execute(askAgent, {
  taskQueue: 'adk',
  workflowId: 'adk-hello',
  args: ['Write a haiku about durable execution.'],
});
console.log(result);
```

## Usage

### Model calls

`TemporalModel` is a Workflow-safe ADK model. Inside a Workflow, each
`generateContentAsync` call runs as a Temporal Activity. Configure Activity
timeouts, retry policy, task queue, summary, and heartbeat timeout with
`TemporalModelOptions.activity`.

```typescript
const agent = new LlmAgent({
  name: 'assistant',
  model: new TemporalModel('gemini-2.5-flash', {
    activity: {
      startToCloseTimeout: '5 minutes',
      heartbeatTimeout: '30 seconds',
      retry: { maximumAttempts: 3 },
    },
  }),
});
```

A model failure is non-retryable unless its status says a retry could succeed,
so a bad request fails the Workflow on the first attempt no matter the retry
policy. To opt out, handle the error in an ADK `onModelErrorCallback`, pass
that same error to `markModelFailureHandled`, and return a substitute event
built with ADK's `createEvent`.

### MCP tools

Use `TemporalMCPToolset` in Workflow code and register the matching MCP factory
on the Worker:

```typescript
// worker
new GoogleAdkPlugin({
  mcpToolsets: {
    filesystem: () => ({
      type: 'StdioConnectionParams',
      serverParams: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'] },
    }),
  },
});

// workflow
const agent = new LlmAgent({
  name: 'fs',
  model: new TemporalModel('gemini-2.5-flash'),
  tools: [new TemporalMCPToolset({ name: 'filesystem' })],
});
```

Per-session MCP state — a pagination cursor, a working directory, an
authenticated session — does not carry from one MCP operation to the next: the
connection params above and ADK's `MCPToolset` both open a new session per
operation rather than reusing one. Holding a session open across operations is
the factory's job — see `MCPToolsetFactory`.

### Activities as tools

Use `activityAsTool` to expose an existing Temporal Activity to the agent:

```typescript
import { activityAsTool } from '@temporalio/google-adk-agents/workflow';
import { Type } from '@google/genai';

const lookupTool = activityAsTool({
  name: 'lookupOrder',
  description: 'Look up an order by id.',
  parameters: { type: Type.OBJECT, properties: { orderId: { type: Type.STRING } } },
});
```

### Streaming

Streaming requires `streamingTopic` on `TemporalModel`. Chunks are published via
`@temporalio/workflow-streams`; the Workflow still receives the complete
transcript as the Activity result.

```typescript
const model = new TemporalModel('gemini-2.5-flash', {
  streamingTopic: 'adk-agent-stream',
  streamingBatchInterval: '100 milliseconds',
  activity: {
    startToCloseTimeout: '5 minutes',
    heartbeatTimeout: '30 seconds',
  },
});

for await (const response of model.generateContentAsync(llmRequest, true)) {
  // `true` requests ADK SSE streaming. Stream subscribers receive chunks on
  // `adk-agent-stream`; the Workflow receives the transcript here.
}
```

### Testing

Import test doubles from the `./testing` entry point to unit-test agents
without a live model or MCP server:

```typescript
import { fakeModelProvider, mockMCPToolset } from '@temporalio/google-adk-agents/testing';

const plugin = new GoogleAdkPlugin({
  modelProvider: fakeModelProvider(),
  mcpToolsets: {
    weather: mockMCPToolset([
      /* tool defs */
    ]),
  },
});
```

## Telemetry and observability

ADK instruments its agent loop with OpenTelemetry. Under this plugin that loop
runs inside the Workflow sandbox, so its spans are created there too, and **by
default they are silently dropped**: nothing registers a tracer provider inside
the sandbox, and a provider configured in the worker process (e.g. `NodeSDK`)
does not reach it.

To export them, compose with the SDK's OpenTelemetry integration
([`@temporalio/interceptors-opentelemetry`](https://github.com/temporalio/sdk-typescript/tree/main/contrib/interceptors-opentelemetry)),
placed before this plugin:

```typescript
import { OpenTelemetryPlugin } from '@temporalio/interceptors-opentelemetry';

const worker = await Worker.create({
  // ...
  plugins: [new OpenTelemetryPlugin({ resource, spanProcessor }), new GoogleAdkPlugin()],
});
```

You then get ADK's agent-loop spans nested under the same trace as the
interceptor's own `RunWorkflow` / `StartActivity` spans. Export is replay-gated,
so replaying a Workflow's history does not re-emit them.

Cautions:

- Do **not** register a custom telemetry sink with `callDuringReplay: true` —
  every replayed workflow task would then re-emit the agent-loop spans,
  over-counting each operation once per replay.
- The replay gate makes span export at-least-once, not exactly-once: a workflow
  task **retry** (a task that failed or timed out and re-executes) is not a
  replay, so its spans are re-emitted. Retries are rare in normal operation, but
  don't build alerting that assumes exact span counts.
- The agent-loop spans carry prompt content as span attributes, and ADK's
  `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false` does not suppress it inside the
  sandbox. Point the span processor somewhere approved for prompt content, or
  strip those attributes there.
- Custom payload/failure converter modules (`payloadConverterPath` /
  `failureConverterPath`) evaluate **before** the plugin's polyfill loader. If
  such a module imports `@google/adk` / `@google/genai`, import
  `@temporalio/google-adk-agents/workflow` first: it installs the sandbox
  polyfills ADK needs.

## Operational notes

- Register `GoogleAdkPlugin` on the Worker. Passing it directly to `Client` does
  not register the model/MCP Activities. If composing plugins, place
  observability and governance plugins before this one.
- Model calls use Temporal retries. The plugin disables nested GenAI SDK retries
  for model requests and honors `retry-after` where available.
- `heartbeatTimeout` detects a dead worker, not a stalled call: when set, the model
  and MCP Activities heartbeat on a timer at half that timeout — a hung call
  included — and a streaming model call heartbeats per chunk regardless. The bound
  on a stalled call is `startToCloseTimeout`, one minute by default.
- Streaming topic delivery is at-least-once. The deterministic Workflow value is
  the Activity result, not the stream side channel.
- `BaseLlm.connect` live BIDI streaming is not supported inside Workflows.
- Any ADK extension point that performs I/O must be moved behind an Activity.

## Troubleshooting

A cryptic sandbox error during a model call — for example `fetch is not defined`,
or a `... is not a function` error from a worker-only module like
`google-auth-library` (the plugin's bundler config aliases such modules to an
empty module in the Workflow bundle) — almost always means a model was not
wrapped in `TemporalModel`. If an agent is configured with a raw model string
(`model: 'gemini-2.5-flash'`) instead of `model: new TemporalModel('gemini-2.5-flash')`,
ADK resolves the string through its `LLMRegistry` inside the Workflow sandbox and
attempts a live network call from there. The sandbox blocks that call, and the
resulting error points nowhere near the actual mistake. Wrap the model in
`TemporalModel` so the call is routed out to an Activity.

## License

MIT
