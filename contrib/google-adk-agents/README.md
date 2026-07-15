# @temporalio/google-adk-agents

Run [Google Agent Development Kit](https://github.com/google/adk-js) (`@google/adk`)
agents as durable [Temporal](https://temporal.io) Workflows.

Your ADK agent graph — `LlmAgent`, `SequentialAgent`/`ParallelAgent`/`LoopAgent`,
`FunctionTool`s, `MCPToolset`s, the `Runner` loop — runs **inside the Workflow**
and replays deterministically. Only the non-deterministic I/O boundaries are
routed out to Activities:

- every **model call** (`generateContentAsync`) becomes a retryable, observable
  Activity, and
- every **MCP tool call** (list-tools / call-tool) becomes an Activity.

Regular `FunctionTool`s run in the Workflow; to have a tool run as an Activity
instead, expose an existing Temporal Activity to the agent with `activityAsTool`.

Temporal then gives you automatic retries, timeouts, heartbeating, and
crash-safe replay for the whole run.

## Install

```bash
npm install @temporalio/google-adk-agents
```

Peer dependency: `@google/adk` `^1.2.0` (and its `@google/genai`). Provide your
Gemini credentials to the **worker** as usual (e.g. `GOOGLE_API_KEY` /
`GEMINI_API_KEY`) — credentials are never placed in workflow or activity inputs.

## Hello world

Take an agent you already have and change **one line** — wrap its model in
`TemporalModel` — then register the plugin.

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
  // Registers invokeModel / invokeModelStreaming for you.
  plugins: [new GoogleAdkPlugin()],
});
await worker.run();
```

### `client.ts`

```typescript
import { Client } from '@temporalio/client';
import { GoogleAdkPlugin } from '@temporalio/google-adk-agents';
import { askAgent } from './workflows';

// Passing the plugin to the Client auto-propagates it to Workers created from
// this Client — register it on EITHER the Client OR the Worker, not both.
const client = new Client({ plugins: [new GoogleAdkPlugin()] });

const result = await client.workflow.execute(askAgent, {
  taskQueue: 'adk',
  workflowId: 'adk-hello',
  args: ['Write a haiku about durable execution.'],
});
console.log(result);
```

## What this plugin gives you

- **Durable model calls.** Swap `model: 'gemini-2.5-flash'` for
  `model: new TemporalModel('gemini-2.5-flash')` and each inference runs as a
  Temporal Activity with a per-model `RetryPolicy`, `startToCloseTimeout`, and
  auto-heartbeat for slow / thinking-mode calls. Upstream `429`/`5xx` and
  `retry-after` headers are honored; non-retryable `4xx` fail fast.
- **Durable MCP tools.** `new TemporalMCPToolset({ name })` routes tool
  discovery and tool calls through Activities. The full tool schema (name,
  description, **parameters**) round-trips, so the model still sees argument
  schemas. MCP connection params stay on the worker:

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

  // workflow / agent
  const agent = new LlmAgent({
    name: 'fs',
    model: new TemporalModel('gemini-2.5-flash'),
    tools: [new TemporalMCPToolset({ name: 'filesystem' })],
  });
  ```

- **Existing Activities as tools.** Already have a Temporal Activity? Expose it
  to the agent with `activityAsTool` instead of re-declaring it:

  ```typescript
  import { activityAsTool } from '@temporalio/google-adk-agents/workflow';
  import { Type } from '@google/genai';

  const lookupTool = activityAsTool({
    name: 'lookupOrder', // a registered Activity on your worker
    description: 'Look up an order by id.',
    parameters: { type: Type.OBJECT, properties: { orderId: { type: Type.STRING } } },
  });
  ```

- **Streaming (SSE).** Streaming requires `streamingTopic` on `TemporalModel`:
  set it to publish incremental `LlmResponse` chunks via
  `@temporalio/workflow-streams` while the Workflow still receives the full
  transcript. Requesting streaming without a `streamingTopic` throws a
  non-retryable `GoogleAdkStreamingTopicRequired` error.
- **Human-in-the-loop.** Because the agent loop runs in the Workflow body, a
  `LongRunningFunctionTool` can `await` a Temporal Signal or Update carrying a
  human's result — no special shim required.
- **Deterministic replay.** ADK's event IDs and timestamps funnel through
  `Math.random()` / `Date.now()`, which the Temporal Workflow sandbox makes
  deterministic — so the agent loop replays without a custom determinism hook.

### Testing your workflows

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

## Under the hood

### Retries

Temporal's `RetryPolicy` is the **sole** retry authority for model calls. Inside
`invokeModel`, the plugin pins the reconstructed `@google/genai` client's
`httpOptions.retryOptions.attempts = 1` so the SDK does not run a second retry
loop _inside_ each Activity attempt (which would multiply latency/request volume
and hide the real failure from Temporal). One Activity attempt is exactly one
model request; Temporal owns backoff, `retry-after` handling, and the retry
budget. Tune it per model via `TemporalModelOptions.activity.retry`.

## Composing with other plugins

Temporal applies `plugins: [...]` in order. Place observability and governance
plugins **before** this one so model/tool Activities are wrapped by them:

```typescript
new Client({
  plugins: [
    new OpenTelemetryPlugin(), // 1. observability (outermost)
    new GovernancePlugin(), // 2. governance
    new GoogleAdkPlugin(), // 3. this plugin
  ],
});
```

This plugin carries no trace context of its own — compose it with
`@temporalio/interceptors-opentelemetry` for distributed tracing across the
model/tool Activity boundary.

## License

MIT
