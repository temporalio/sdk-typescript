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
npm install @temporalio/google-adk-agents
```

Peer dependency: `@google/adk` `>=1.4.0 <1.6.0` and its `@google/genai`. The test
suite runs against 1.4.0; 1.5.x is allowed but untested. There is an upper bound
because a newer ADK can fail at Workflow-bundle load with an error that names
neither ADK nor a version. Provide Gemini credentials to the Worker as usual, for
example with `GOOGLE_API_KEY` or `GEMINI_API_KEY`.

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

Nothing is pooled: every MCP operation opens its own session — its own
`initialize` handshake, and against a stdio server its own subprocess — and closes
it before returning. ADK resolves the agent's toolsets twice while building each
request, so every model request is preceded by two `<name>-listTools` Activities,
one session each; `<name>-callTool` re-lists the server's tools to resolve the name
before invoking it, so that single Activity opens two. A turn where the model calls
one tool and then answers therefore runs seven Activities — two `adk-invokeModel`,
four `<name>-listTools`, one `<name>-callTool` — and opens six sessions. Every one
of those Activities is recorded in Workflow history, so the Activity count is plain
in the Temporal UI; the sessions each Activity opens are not.

Because no session outlives the operation that opened it, an MCP server that keeps
per-session state (a pagination cursor, a working directory, an authenticated
session) will not work behind this plugin.

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

ADK instruments its agent loop with OpenTelemetry: the `gcp.vertex.agent`
tracer creates `invocation`, `invoke_agent <name>`, `call_llm` (with
`gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` attributes), and
`execute_tool` spans. Under this plugin the agent loop runs inside the Workflow
sandbox, so those spans are created there too — and **by default they are
silently dropped**: nothing registers a tracer provider inside the sandbox, so
ADK's tracer yields non-recording no-ops. A tracer provider configured in the
worker process (e.g. `NodeSDK`) does not see them either; the sandbox is
isolated from process globals.

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

Its Workflow interceptor registers a tracer provider inside the sandbox that
ADK's tracer binds to, and exports the spans through a Worker sink that is
**replay-gated**: spans are recorded when Workflow code first executes;
history replays re-run the agent-loop code but re-export nothing. Absent
workflow task retries (see the cautions below), you get exactly one span per
real model call or tool call, plus the interceptor's own `RunWorkflow` /
`StartActivity` spans, nested under the same trace. The plugin
pins `@opentelemetry/api` to a single copy in the Workflow bundle (the one
`@google/adk` resolves — ADK pins an exact api version, so a bundle could
otherwise contain two copies), so ADK's tracer binds to that provider no
matter which module evaluates ADK first.

Cautions:

- Do **not** register a custom telemetry sink with `callDuringReplay: true` —
  every replayed workflow task would then re-emit the agent-loop spans,
  over-counting each operation once per replay.
- The replay gate makes span export at-least-once, not exactly-once: a workflow
  task **retry** (a task that failed or timed out and re-executes) is not a
  replay, so its spans are re-emitted. Retries are rare in normal operation, but
  don't build alerting that assumes exact span counts.
- `call_llm` spans carry the full request/response payloads as
  `gcp.vertex.agent.llm_request` / `gcp.vertex.agent.llm_response` attributes.
  Point the span processor somewhere approved for prompt content, or strip
  those attributes in the processor.
- Custom payload/failure converter modules (`payloadConverterPath` /
  `failureConverterPath`) evaluate **before** the plugin's polyfill loader. If
  such a module imports `@google/adk` / `@google/genai`, import
  `@temporalio/google-adk-agents/workflow` first: it installs the sandbox
  polyfills (`Headers`, `structuredClone`, the WHATWG streams globals, and the
  deterministic `performance` shim ADK's telemetry chain dereferences at module
  load) before ADK evaluates.

ADK (as of 1.4.0) defines no OpenTelemetry metric instruments, so there is no
workflow-side metric telemetry to configure. Activity-side telemetry (the real
Gemini/MCP calls) runs in the worker process where normal Node OpenTelemetry
setup applies, and is naturally replay-immune — completed Activities are read
from history rather than re-executed.

## Operational notes

- Register `GoogleAdkPlugin` on the Worker. Passing it directly to `Client` does
  not register the model/MCP Activities. If composing plugins, place
  observability and governance plugins before this one.
- Model calls use Temporal retries. The plugin disables nested GenAI SDK retries
  for model requests and honors `retry-after` where available.
- Set `heartbeatTimeout` in the Activity options to have a stalled model or MCP
  call detected before `startToCloseTimeout` expires. The plugin then heartbeats
  every such call at half that timeout, and a streaming model call on each chunk as
  well. Without it there is no heartbeat, and only `startToCloseTimeout` ends a
  stalled call.
- Streaming topic delivery is at-least-once. The deterministic Workflow value is
  the Activity result, not the stream side channel.
- `BaseLlm.connect` live BIDI streaming is not supported inside Workflows.
- Any ADK extension point that performs I/O must be moved behind an Activity.

## Error types

Failures the plugin raises carry a stable `ApplicationFailure.type`; the matching
constants are exported from `@temporalio/google-adk-agents/workflow`. Only the
failures raised inside an Activity arrive wrapped — the rest are thrown where they
happened — so read the type off the error itself or the first `ApplicationFailure`
in its `.cause` chain rather than reaching for a fixed `err.cause.type`. Match
`MODEL_ERROR_FAILURE_TYPE` with `startsWith`, not `===`: the plugin appends the
upstream HTTP status wherever it read one, and emits the bare value only when the
failure reported no status.

| `failure.type`                                        | Constant                                      | Raised when                                                                                                                                                                            | Reaches Workflow code as                                                                         |
| :---------------------------------------------------- | :-------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- |
| `GoogleAdkModelError`, `GoogleAdkModelError.<status>` | `MODEL_ERROR_FAILURE_TYPE`                    | A model or MCP call failed. The upstream HTTP status, where there was one, is appended.                                                                                                | `ActivityFailure`; read `.cause` — but not from a model or tool call inside an agent run (below) |
| `GoogleAdkMCPToolNotFound`                            | `MCP_TOOL_NOT_FOUND_FAILURE_TYPE`             | `<name>-callTool` found no tool by the requested name: the server's list changed since discovery, workers disagree on what `<name>` resolves to, or the Activity was invoked directly. | `ActivityFailure`; read `.cause` — but not from a tool call inside an agent run (below)          |
| `GoogleAdkStreamingTopicRequired`                     | `STREAMING_TOPIC_REQUIRED_FAILURE_TYPE`       | Streaming was requested without `TemporalModelOptions.streamingTopic`.                                                                                                                 | Thrown by `TemporalModel.generateContentAsync` — but not inside an agent run (below)             |
| `GoogleAdkUnsupported`                                | `UNSUPPORTED_FAILURE_TYPE`                    | `BaseLlm.connect` (BIDI live streaming) was called inside a Workflow.                                                                                                                  | Thrown by `TemporalModel.connect`                                                                |
| `GoogleAdkMCPToolsetOutsideWorkflow`                  | `MCP_TOOLSET_OUTSIDE_WORKFLOW_FAILURE_TYPE`   | `TemporalMCPToolset.getTools()` ran outside a Workflow with no `connectionParams`.                                                                                                     | Thrown to the direct caller                                                                      |
| `GoogleAdkActivityToolOutsideWorkflow`                | `ACTIVITY_TOOL_OUTSIDE_WORKFLOW_FAILURE_TYPE` | An `activityAsTool` tool ran outside a Workflow.                                                                                                                                       | Thrown to the direct caller                                                                      |

Inside an `LlmAgent` run, most of these never reach a `try`/`catch` around
`runAsync` / `runEphemeral`. ADK catches a failing model call and yields an event
carrying `errorCode` and `errorMessage` — not the plugin's `failure.type` — instead
of rethrowing, and it turns a failing tool call, including a non-retryable
`GoogleAdkMCPToolNotFound`, into an `{ error }` tool response fed back to the model,
so the agent keeps going. Neither fails the Workflow: a model outage that exhausts
its Activity retries surfaces only as an error event in the run stream, so decide
whether a run succeeded by inspecting the events the runner yields, not by catching
a thrown error. Tool discovery is the exception —
`<name>-listTools` runs while the request is still being built, outside that
handler, so its failure propagates out of the runner and fails the Workflow.

`GoogleAdkModelError` is the only type whose retryability varies; every other type
above is non-retryable. A failure carrying an HTTP status is retryable when that
status is 408, 409, 429 or 5xx, and non-retryable otherwise. A failure carrying no
HTTP status — a transport, network or gRPC error — is retryable. An `x-should-retry`
header overrides either verdict, and `retry-after` / `retry-after-ms` becomes the
failure's `nextRetryDelay`.

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
