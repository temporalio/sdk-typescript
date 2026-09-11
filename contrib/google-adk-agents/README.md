# @temporalio/google-adk-agents

Run [Google Agent Development Kit](https://github.com/google/adk-js) (`@google/adk`)
agents as durable [Temporal](https://temporal.io) Workflows.

Your ADK agent graph — agents, tools, plugins, and ADK 2.0's workflow (graph)
runtime — runs inside the Workflow and replays deterministically. The plugin
routes non-deterministic boundaries out to Activities:

- every **model call** (`generateContentAsync`) becomes a retryable, observable
  Activity,
- every **MCP tool call** (list-tools / call-tool) becomes an Activity,
- an **Activity** can be a graph node (`activityNode`) or a tool (`activityAsTool`).

Regular ADK `FunctionTool`s still run in the Workflow. If a tool performs I/O,
wrap an existing Temporal Activity with `activityAsTool`.

## Install

```bash
npm install @temporalio/google-adk-agents @google/adk @google/genai
```

The supported peer range is `@google/adk` `>=2.0.0 <2.1.0` and `@google/genai`
`^2.9.0`. The ceiling is exact by design: the plugin's Workflow-sandbox shims are
keyed to what ADK reaches at module load, so an ADK minor outside this range can
break the Workflow bundle. `@modelcontextprotocol/sdk` is an optional peer: install
it if you use `TemporalMCPToolset` (ADK 2.0 made it optional too).

Provide Gemini credentials to the Worker as usual, for example with
`GOOGLE_GENAI_API_KEY`, `GOOGLE_API_KEY` or `GEMINI_API_KEY`.

### Upgrading from ADK 1.5

Versions of this plugin for `@google/adk` 1.5 are not compatible with 2.0, and a
Workflow started under 1.5 cannot be replayed by a Worker on 2.0: ADK's internals
and its id generation changed. Drain in-flight Workflows before switching, or run
the two versions on separate task queues. Nothing in your Workflow code has to
change.

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

### Graph workflows

ADK 2.0's workflow runtime — `Workflow`, `node()`, `JoinNode`, routing,
`dynamicEntry`, `RequestInput` — is plain async code driven by session events,
so it runs inside a Temporal Workflow unchanged. Use `activityNode` to make a
registered Activity a node:

```typescript
import { JoinNode, Workflow, createEvent, node } from '@google/adk';
import { activityNode } from '@temporalio/google-adk-agents/workflow';

const fetchA = activityNode({ name: 'fetchData', nodeName: 'fetch_a', args: () => ['a'] });
const fetchB = activityNode({ name: 'fetchData', nodeName: 'fetch_b', args: () => ['b'] });
const join = new JoinNode({ name: 'join' });
const summarize = activityNode({
  name: 'summarize',
  activity: { startToCloseTimeout: '2 minutes', retry: { maximumAttempts: 3 } },
});

const graph = new Workflow({
  name: 'report',
  edges: [
    ['START', fetchA, join],
    ['START', fetchB, join],
    [join, summarize],
  ],
});
const runner = new InMemoryRunner({ agent: graph });
```

- **Input and output.** By default the node's input is passed to the Activity as
  its single argument and the Activity's result is the node's output; `args`
  maps the input (and `NodeContext`, for state) to the Activity's argument list.
- **Routing.** A node returns `createEvent({ route: 'approve', output })` and the
  edge `[router, { approve: a, [DEFAULT_ROUTE]: b }]` picks the branch; only that
  branch's Activity runs.
- **Dynamic nodes.** Inside a `node(async (ctx, input) => …)` body,
  `await ctx.runNode(activityNode(…), input)` runs the Activity as a child and
  returns its result — in loops, in `Promise.all`, behind conditions.
- **Node as tool.** A `Workflow` (or any node) in an `LlmAgent`'s `tools` becomes a
  tool. Give it a Zod object `inputSchema` for real parameters; a genai `Schema`
  advertises a single `request` string, which only a string-typed schema accepts.
- **Retries and timeouts.** Prefer Temporal's `activity.retry` and timeouts. ADK's
  `retryConfig` re-runs the whole node on top of them (match an Activity failure
  with `exceptions: ['ActivityFailure']`; ADK matches error names), its backoff is
  a durable timer, and its jitter is drawn from the Workflow's `Math.random()`.
  A node `timeout` (seconds) is a durable timer that cancels the in-flight
  Activity and fails the node with ADK's `NodeTimeoutError`.
- **Resume.** ADK resumes a paused graph from the session's events: a node that
  already produced output is fast-forwarded rather than re-run. `activityNode`
  defaults `rerunOnResume` to `false`, so its Activity is not scheduled again;
  ADK's `Workflow` and `LlmAgent` default it to `true`. Resume is at-least-once
  for a dynamic node's body — put side effects in `activityNode` /
  `activityAsTool` children, or make them idempotent.
- `LongRunningFunctionTool`s (including a node-as-tool) cannot be used as a
  `ToolNode`; ADK rejects that.

### Failures

A model or Activity failure ends the Workflow through its `ActivityFailure` as
usual. ADK's own runtime errors are plain `Error`s, and the Temporal SDK treats an
unexpected error as a Workflow _Task_ failure that retries forever; the plugin
therefore converts the ones a graph produces as outcomes into non-retryable
`ApplicationFailure`s (the ADK error is the `cause`):

| ADK error                   | `ApplicationFailure.type`                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `NodeTimeoutError`          | `GoogleAdkNodeTimeoutError`                                                                                                   |
| `NodeReportedError`         | `GoogleAdkNodeReportedError` (or the recorded model `ActivityFailure` when a `TemporalModel` call was what the node absorbed) |
| `NodeSchemaValidationError` | `GoogleAdkNodeSchemaValidationError`                                                                                          |
| `IntentMismatchError`       | `GoogleAdkIntentMismatchError`                                                                                                |
| `StateSchemaError`          | `GoogleAdkStateSchemaError`                                                                                                   |
| `InvocationAbortedError`    | `GoogleAdkInvocationAbortedError`                                                                                             |
| `DynamicNodeFailError`      | `GoogleAdkDynamicNodeFailError`                                                                                               |

The mapping is exported as `ADK_RUNTIME_FAILURE_TYPES`. Anything else ADK throws
— a malformed human reply, `StreamingMode.BIDI`, a reserved function _call_ in a
client message — keeps the SDK's convention; use
`WorkerOptions.workflowFailureErrorTypes` to fail the execution on more.

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

You then get ADK's spans — `invocation`, `invoke_agent <name>`, `call_llm`, and
for the workflow runtime `invoke_workflow <name>`, `execute_node <name>`,
`execute_node_attempt <name>` — nested under the same trace as the interceptor's
own `RunWorkflow` / `StartActivity` spans. Export is replay-gated, so replaying a
Workflow's history does not re-emit them.

Cautions:

- Do **not** register a custom telemetry sink with `callDuringReplay: true` —
  every replayed workflow task would then re-emit the agent-loop spans,
  over-counting each operation once per replay.
- The replay gate makes span export at-least-once, not exactly-once: a workflow
  task **retry** (a task that failed or timed out and re-executes) is not a
  replay, so its spans are re-emitted. Retries are rare in normal operation, but
  don't build alerting that assumes exact span counts.
- ADK attaches its `adk.workflow.*` / `adk.node.*` attributes to the _active_
  span, and no OpenTelemetry context manager runs inside the sandbox, so those
  attributes are absent; span names and counts are reliable.
- The agent-loop spans carry prompt content as span attributes, and ADK's
  `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false` does not suppress it inside the
  sandbox. Point the span processor somewhere approved for prompt content, or
  strip those attributes there.
- Custom payload/failure converter modules (`payloadConverterPath` /
  `failureConverterPath`) evaluate **before** the plugin's polyfill loader. If
  such a module imports `@google/adk` / `@google/genai`, import
  `@temporalio/google-adk-agents/workflow` first: it installs the sandbox
  polyfills ADK needs.

## Determinism notes

- ADK generates ids — event, invocation and session ids, function-call ids — with
  `randomUUID()`. The sandbox has no `crypto`,
  so the plugin serves ADK a `crypto` module whose values come from a **named
  workflow random stream**: replay-stable, and independent of the Workflow's own
  `Math.random()` sequence. Those ids are **not cryptographically random** inside
  a Workflow; nor is ADK's OAuth2 `state`, which is one reason credential flows are
  unsupported there.
- ADK's node retry backoff and timeouts are durable timers; the retry jitter is
  drawn from the Workflow's `Math.random()`.
- ADK resumes a paused run from the session events: completed nodes are
  fast-forwarded, a dynamic node's body re-runs.

## Not supported in Workflows

- **Live / bidirectional streaming**: `Runner.runLive`, `StreamingMode.BIDI` and
  `BaseLlm.connect` (`TemporalModel.connect` throws `GoogleAdkUnsupported`; ADK
  itself rejects `StreamingMode.BIDI` in `runAsync`).
- **Node-only ADK services.** The Workflow bundle uses ADK's web surface. It type-
  checks against ADK's full typings, but these are `undefined` at run time in a
  Workflow: the MCP classes (`MCPToolset`, `MCPSessionManager` — use
  `TemporalMCPToolset`), a2a, `DatabaseSessionService`, `GcsArtifactService` /
  `FileArtifactService`, telemetry setup, `LocalEnvironment`, the agent registry.
  Present but non-functional there: the skills loaders, the code executors, and
  `ApigeeLlm` (replaced by an inert class; wrap it in `TemporalModel`).
- **Thread-pool tool execution** and any ADK extension point that performs I/O;
  move it behind an Activity.

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

## Troubleshooting

- A cryptic sandbox error during a model call — for example `fetch is not defined`,
  or a `... is not a function` error from a worker-only module like
  `google-auth-library` (the plugin's bundler config aliases such modules to an
  empty module in the Workflow bundle) — almost always means a model was not
  wrapped in `TemporalModel`. If an agent is configured with a raw model string
  (`model: 'gemini-2.5-flash'`) instead of `model: new TemporalModel('gemini-2.5-flash')`,
  ADK resolves the string through its `LLMRegistry` inside the Workflow sandbox and
  attempts a live network call from there. The sandbox blocks that call, and the
  resulting error points nowhere near the actual mistake. Wrap the model in
  `TemporalModel` so the call is routed out to an Activity.
- `X is not a constructor` / `X is not a function` for an ADK symbol inside a
  Workflow means the symbol is one of the node-only services above: the Workflow
  bundle resolves ADK's web surface, which omits it. Use it worker-side.

## License

MIT
