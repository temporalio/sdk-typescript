# Strands Agents

⚠️ **This package is currently at an experimental release stage.** ⚠️

This Temporal [Plugin](https://docs.temporal.io/develop/plugins-guide) allows you to run [Strands Agents](https://strandsagents.com/) inside Temporal Workflows, routing model invocations, tool calls, and MCP tool calls through Temporal Activities for durable execution, Temporal-managed retries, and timeouts.

## Installation

```sh
npm install @temporalio/strands-agents @strands-agents/sdk
```

## Quickstart

`workflow.ts` defines the workflow:

```ts
import { proxyActivities, defineWorkflow } from '@temporalio/workflow';
import { TemporalAgent } from '@temporalio/strands-agents';

export async function myWorkflow(prompt: string): Promise<string> {
  const agent = new TemporalAgent({
    activityOptions: { startToCloseTimeout: '60 seconds' },
  });
  const result = await agent.invoke(prompt);
  return result.lastMessage?.toString() ?? '';
}
```

`worker.ts` runs the worker:

```ts
import { Worker, NativeConnection } from '@temporalio/worker';
import { StrandsPlugin } from '@temporalio/strands-agents';

const connection = await NativeConnection.connect({ address: 'localhost:7233' });
const worker = await Worker.create({
  connection,
  taskQueue: 'strands',
  workflowsPath: require.resolve('./workflow'),
  plugins: [new StrandsPlugin()],
});
await worker.run();
```

`client.ts` starts the workflow:

```ts
import { Client } from '@temporalio/client';
import { myWorkflow } from './workflow';

const client = new Client();
const result = await client.workflow.execute(myWorkflow, {
  args: ['Hello'],
  taskQueue: 'strands',
  workflowId: 'strands-quickstart',
});
console.log(result);
```

## Models

`new StrandsPlugin({ models })` takes a mapping of `name → factory`. Each factory is called lazily on first use (on the worker, outside the workflow sandbox) and the constructed model is cached for the worker's lifetime. `new TemporalAgent({ model: 'name', ... })` selects which factory to invoke and carries the activity options for that agent's model calls. If `models` is omitted, the plugin registers a single `BedrockModel` factory under the name `"bedrock"`, matching Strands' own implicit default.

```ts
import { BedrockModel } from '@strands-agents/sdk/models/bedrock';
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic';
import { TemporalAgent, StrandsPlugin } from '@temporalio/strands-agents';

// workflow
export async function multiModelWorkflow(prompt: string): Promise<string> {
  const a = new TemporalAgent({
    model: 'claude',
    activityOptions: { startToCloseTimeout: '60 seconds' },
  });
  const b = new TemporalAgent({
    model: 'bedrock',
    activityOptions: { startToCloseTimeout: '60 seconds' },
  });
  // ...
}

// worker
new StrandsPlugin({
  models: {
    claude: () => new AnthropicModel({ apiKey: '...' }),
    bedrock: () => new BedrockModel({}),
  },
});
```

Each `TemporalAgent` carries its own activity options (timeouts, retry policy, task queue, streaming topic) and dispatches to the shared model activity, which resolves the model name against the registered factories at runtime. A name not present in `models` throws inside the activity.

## Retries

`TemporalAgent` disables Strands' built-in `ModelRetryStrategy` so retries are handled exclusively by Temporal. Configure retries via `activityOptions.retry` on `TemporalAgent`, and on the activity options accepted by `workflow.activityAsTool`, `workflow.activityAsHook`, and `TemporalMCPClient`:

```ts
new TemporalAgent({
  activityOptions: {
    startToCloseTimeout: '60 seconds',
    retry: { maximumAttempts: 3 },
  },
});
```

Passing `retryStrategy` to `new TemporalAgent(...)` throws; remove the argument and put the retry config on the activity options instead.

## Snapshots

`TemporalAgent.takeSnapshot()` and `TemporalAgent.loadSnapshot()` throw. Temporal's event history already persists workflow state durably at a finer granularity than Strands snapshots, so calling either inside a workflow is redundant.

## Structured Output

Like Strands' `Agent`, `TemporalAgent` supports structured output via `structuredOutputSchema`. The values flow through the model activity unchanged; supply any Zod schema:

```ts
import { z } from 'zod';

const PersonInfo = z.object({ name: z.string(), age: z.number() });

export async function myWorkflow(prompt: string) {
  const agent = new TemporalAgent({
    activityOptions: { startToCloseTimeout: '60 seconds' },
    structuredOutputSchema: PersonInfo,
  });
  const result = await agent.invoke(prompt);
  return result.structuredOutput;
}
```

## Streaming

To forward model chunks to external consumers, pass `streamingTopic: '...'` to `TemporalAgent` and host a workflow stream on the workflow via [`@temporalio/workflow-streams`](../workflow-streams). Each model stream event is published on the named topic from inside the model activity; subscribers read via `WorkflowStreamClient`. Chunks are batched on `streamingBatchInterval` (default `'100 milliseconds'`).

```ts
import { WorkflowStream } from '@temporalio/workflow-streams/workflow';
import { WorkflowStreamClient } from '@temporalio/workflow-streams/client';

// workflow
export async function streamingWorkflow(prompt: string) {
  new WorkflowStream();
  const agent = new TemporalAgent({
    activityOptions: { startToCloseTimeout: '60 seconds' },
    streamingTopic: 'events',
  });
  await agent.invoke(prompt);
}

// client
const stream = WorkflowStreamClient.create(client, workflowId);
for await (const item of stream.subscribe(['events'])) {
  console.log(item);
}
```

## Tools

Wrap an activity registered on the worker with `workflow.activityAsTool(name, options)`:

```ts
// activities/index.ts
export async function fetchUser(userId: string): Promise<{ name: string }> {
  // ...
}

// workflow.ts
import { workflow as strandsWorkflow, TemporalAgent } from '@temporalio/strands-agents';
import { z } from 'zod';

export async function toolsWorkflow(prompt: string) {
  const agent = new TemporalAgent({
    activityOptions: { startToCloseTimeout: '60 seconds' },
    tools: [
      strandsWorkflow.activityAsTool('fetchUser', {
        description: 'Fetch user by id',
        inputSchema: z.object({ userId: z.string() }),
        activityOptions: { startToCloseTimeout: '30 seconds' },
      }),
    ],
  });
  return await agent.invoke(prompt);
}

// worker.ts
new Worker({
  // ...
  activities: { fetchUser },
  plugins: [new StrandsPlugin({ models })],
});
```

## Hooks

Strands' [hook system](https://strandsagents.com/) lets you subscribe callbacks to events in the agent lifecycle — invocation start/end, model call before/after, tool call before/after, message added. Pass `hooks=[...]` via Strands' standard plugin API to `TemporalAgent`: every hook event fires in workflow context, so deterministic callbacks just work.

Callbacks run in workflow context, so they must be deterministic: no `Date.now()`, `randomUUID()`, or I/O — same rules as workflow code. For callbacks that need I/O (audit logging, metrics, alerting), use `workflow.activityAsHook()` to dispatch the work as a Temporal activity:

```ts
// activities/index.ts
export async function persistToolCall(toolName: string): Promise<void> {
  // I/O safely in an activity.
}

// workflow.ts
import { workflow as strandsWorkflow } from '@temporalio/strands-agents';
import { AfterToolCallEvent } from '@strands-agents/sdk';

const auditCallback = strandsWorkflow.activityAsHook<AfterToolCallEvent, string>('persistToolCall', {
  activityInput: (event) => event.toolUse.name,
  activityOptions: { startToCloseTimeout: '10 seconds' },
});

agent.addHook(AfterToolCallEvent, auditCallback);
```

`activityInput` extracts serializable values from the event to pass as the activity's input. Events themselves are not serializable because they hold references to the `Agent`, `Tool` instances, etc.

## Human-in-the-loop interrupts

Strands supports interrupts via `toolContext.interrupt(...)` and `event.interrupt(...)`. Both work with the plugin: `agent.invoke()` returns `AgentResult` with `stopReason: 'interrupt'` and `interrupts: [...]`. Pair this with a signal handler that supplies responses, then resume by calling `agent.invoke(responses)`.

Interrupts also survive the activity boundary when raised from an `activityAsTool`-wrapped activity. The plugin's failure converter packages the interrupt as a typed `ApplicationFailure`, and `TemporalActivityTool` re-raises it through the agent's interrupt machinery on the workflow side, so `AgentResult.interrupts` is populated just like the in-workflow case.

This relies on the plugin's failure converter, which is installed via the client's data converter. **Attach `StrandsPlugin` to the client** (not just the worker) for activity-tool interrupts to work — workers built from that client pick up the plugin automatically.

```ts
const client = new Client({ /* ... */, plugins: [new StrandsPlugin({ models })] });
```

## Continue-as-new

A chat-style workflow accumulates history with every turn and will eventually hit Temporal's per-workflow history limit. `workflowInfo().continueAsNewSuggested` flips true once the server decides history has grown large enough; check it after each turn and hand off to a fresh run, carrying `agent.messages` as input:

```ts
import { defineSignal, setHandler, condition, continueAsNew, workflowInfo } from '@temporalio/workflow';
import { TemporalAgent } from '@temporalio/strands-agents';
import type { Message } from '@strands-agents/sdk';

export const userSays = defineSignal<[string]>('userSays');
export const endChat = defineSignal('endChat');

export interface ChatInput {
  messages?: Message[];
}

export async function chatWorkflow(input: ChatInput = {}): Promise<void> {
  const agent = new TemporalAgent({
    activityOptions: { startToCloseTimeout: '60 seconds' },
    messages: input.messages,
  });

  const pending: string[] = [];
  let done = false;
  setHandler(userSays, (prompt) => void pending.push(prompt));
  setHandler(endChat, () => void (done = true));

  while (true) {
    await condition(() => pending.length > 0 || done);
    if (done) return;
    await agent.invoke(pending.shift()!);
    if (workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof chatWorkflow>({ messages: agent.messages });
    }
  }
}
```

## MCP

`new StrandsPlugin({ mcpClients })` takes a mapping of `name → McpClient factory`, mirroring the `models` pattern. The plugin registers per-server `{name}-listTools` and `{name}-callTool` activities. Workflow-side, `new TemporalMCPClient({ server: 'name' })` is a thin handle: it references the server by name and carries the per-call activity options.

```ts
import { McpClient } from '@strands-agents/sdk';
import { TemporalMCPClient } from '@temporalio/strands-agents';

// workflow
export async function mcpWorkflow(prompt: string) {
  const echo = new TemporalMCPClient({
    server: 'echo',
    activityOptions: { startToCloseTimeout: '30 seconds' },
  });
  const agent = new TemporalAgent({
    activityOptions: { startToCloseTimeout: '60 seconds' },
    tools: [echo],
  });
  return await agent.invoke(prompt);
}

// worker
new Worker({
  // ...
  plugins: [
    new StrandsPlugin({
      mcpClients: {
        echo: () => new McpClient({ url: 'http://localhost:8765/mcp' }),
      },
    }),
  ],
});
```

Each factory returns a fully configured `McpClient`. The connection is opened lazily on first use rather than at worker startup.

By default, `TemporalMCPClient` re-lists the server's tools (via `{name}-listTools`) on every agent turn, so an MCP server that is restarted or redeployed mid-workflow — with tools added, removed, or renamed — is picked up. To list the tools just once at the beginning of the workflow and reuse that schema for the workflow's lifetime (one fewer activity per turn), set `cacheTools: true`:

```ts
const echo = new TemporalMCPClient({
  server: 'echo',
  cacheTools: true,
  activityOptions: { startToCloseTimeout: '30 seconds' },
});
```

To amortize connection setup, the `{name}-listTools` and `{name}-callTool` activities share one worker-process MCP connection and reuse it across calls. The connection is disconnected after it sits idle for `mcpConnectionIdleTimeout` (default 5 minutes); the timer resets on every reuse. `mcpConnectionIdleTimeout` accepts a millisecond number or a duration string (e.g. `'30 seconds'`), like `startToCloseTimeout`:

```ts
new StrandsPlugin({
  mcpClients: { echo: () => new McpClient({ url: 'http://localhost:8765/mcp' }) },
  mcpConnectionIdleTimeout: '30 seconds',
});
```

## Observability

`StrandsPlugin` composes cleanly with [`OpenTelemetryPlugin`](../interceptors-opentelemetry). Register both on the client and the worker. You'll get OTel spans around the model, tool, and MCP activities the plugin schedules, plus any spans Strands itself emits inside `invoke`:

```ts
import { OpenTelemetryPlugin } from '@temporalio/interceptors-opentelemetry';
import { Resource } from '@opentelemetry/resources';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';

const otel = new OpenTelemetryPlugin({
  resource: new Resource({ 'service.name': 'strands-worker' }),
  spanProcessor: new SimpleSpanProcessor(new OTLPTraceExporter()),
});

// client
const client = new Client({ plugins: [otel] });

// worker
const worker = await Worker.create({
  connection,
  taskQueue: 'strands',
  workflowsPath: require.resolve('./workflow'),
  plugins: [otel, new StrandsPlugin({ models })],
});
```

See the [OpenTelemetry interceptor README](../interceptors-opentelemetry) for exporter setup.
