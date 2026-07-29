# OpenAI Agents SDK Integration for Temporal

> ⚠️ **This package is currently at an experimental release stage.** ⚠️

Run [OpenAI Agents SDK](https://github.com/openai/openai-agents-js) agents as Temporal Workflows. Agent orchestration runs in the Workflow; model calls run as Activities, so they retry durably and are not repeated during Workflow replay.

## Install

```bash
# Or `pnpm add`/`yarn add`
npm install @temporalio/openai-agents @openai/agents-core @openai/agents-openai openai
```

`@openai/agents-core`, `@openai/agents-openai`, and `openai` are peer dependencies.

## Quick start

Create a Workflow that uses `TemporalOpenAIRunner` instead of the upstream `Runner`:

```ts
import { Agent } from '@openai/agents-core';
import { TemporalOpenAIRunner } from '@temporalio/openai-agents/workflow';

export async function haikuAgentWorkflow(prompt: string): Promise<string> {
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You only respond in haikus.',
    model: 'gpt-4o-mini',
  });

  const runner = new TemporalOpenAIRunner();
  const result = await runner.run(agent, prompt);
  return result.finalOutput ?? '';
}
```

Register `OpenAIAgentsPlugin` on the Worker so model Activities, Workflow interceptors, sinks, and polyfills are installed:

```ts
import { OpenAIProvider } from '@openai/agents-openai';
import { OpenAIAgentsPlugin } from '@temporalio/openai-agents';
import { NativeConnection, Worker } from '@temporalio/worker';

async function main() {
  const connection = await NativeConnection.connect();
  const plugin = new OpenAIAgentsPlugin({
    modelProvider: new OpenAIProvider(),
    modelParams: { startToCloseTimeout: '30s' },
  });

  const worker = await Worker.create({
    connection,
    taskQueue: 'my-task-queue',
    workflowsPath: require.resolve('./workflows'),
    plugins: [plugin],
  });

  await worker.run();
}

main();
```

Register the same plugin type on the Client so model parameters and tracing options propagate to new Workflows:

```ts
import { OpenAIProvider } from '@openai/agents-openai';
import { Client, Connection } from '@temporalio/client';
import { OpenAIAgentsPlugin } from '@temporalio/openai-agents';

async function main() {
  const connection = await Connection.connect();
  const plugin = new OpenAIAgentsPlugin({
    modelProvider: new OpenAIProvider(),
  });

  const client = new Client({
    connection,
    plugins: [plugin],
  });

  const result = await client.workflow.execute('haikuAgentWorkflow', {
    args: ['Tell me about recursion in programming.'],
    taskQueue: 'my-task-queue',
    workflowId: 'haiku-workflow',
  });

  console.log(result);
}

main();
```

## Workflow runner

`TemporalOpenAIRunner` mirrors the OpenAI Agents SDK `Runner` for Workflow-safe execution. Use `run(agent, input, options?)` with familiar options such as `maxTurns`, `context`, `session`, and guardrails.

Differences from the upstream runner:

- `runConfig.model` must be a model name string. The Worker's `modelProvider` resolves it inside the model Activity.
- `signal` is not supported. Use Temporal cancellation APIs, such as `CancellationScope`, to cancel Workflow work.

### Run state and approvals

`TemporalOpenAIRunner.run` accepts a `RunState` as the second argument, matching the upstream runner. This supports human approval flows that pause, wait for a Signal or Update, then continue as new.

```ts
import { Agent, RunState, tool } from '@openai/agents-core';
import { TemporalOpenAIRunner } from '@temporalio/openai-agents/workflow';
import { condition, continueAsNew, defineSignal, setHandler } from '@temporalio/workflow';

const approveSignal = defineSignal('approve');

interface ApprovalInput {
  resumeFromRunState?: string;
}

export async function approvalWorkflow(input: ApprovalInput = {}): Promise<string> {
  const action = tool({
    name: 'dangerousAction',
    description: 'Perform an action that needs approval',
    parameters: {
      type: 'object' as const,
      properties: { reason: { type: 'string' } },
      required: ['reason'] as const,
      additionalProperties: false as const,
    },
    needsApproval: true,
    execute: async (args) => `did: ${(args as { reason: string }).reason}`,
  });

  const agent = new Agent({
    name: 'Approver',
    instructions: 'Use dangerousAction when asked.',
    model: 'gpt-4o-mini',
    tools: [action],
  });
  const runner = new TemporalOpenAIRunner();

  if (input.resumeFromRunState !== undefined) {
    const state = await RunState.fromString(agent, input.resumeFromRunState);
    for (const interruption of state.getInterruptions()) {
      state.approve(interruption);
    }
    const resumed = await runner.run(agent, state);
    return resumed.finalOutput ?? '';
  }

  let approved = false;
  setHandler(approveSignal, () => {
    approved = true;
  });

  const result = await runner.run(agent, 'please act');
  if (result.interruptions.length === 0) return result.finalOutput ?? '';

  await condition(() => approved);
  await continueAsNew<typeof approvalWorkflow>({ resumeFromRunState: result.state.toString() });
  throw new Error('unreachable');
}
```

The agent passed to `RunState.fromString` must define the same tool names, handoff graph, and MCP servers as the run that produced the serialized state.

### Streaming

> **Experimental** — streaming support is subject to change prior to General Availability.

Pass `{ stream: true }` to `run()` to stream incremental events as the model responds. The call returns the upstream `StreamedRunResult`, an async-iterable of agent-SDK stream events. Inside a Workflow, each model call executes as a streaming Activity (`invokeModelStreamActivity`) that consumes `Model.getStreamedResponse` and returns the collected list of native model events. The Workflow yields those events deterministically from the Activity's return value — it never polls the live stream, so replay stays deterministic.

External consumers (UIs, tracing pipelines) observe events as they arrive by hosting a [`WorkflowStream`](../workflow-streams/README.md) in the Workflow and subscribing with `WorkflowStreamClient`. The streaming Activity publishes each event to the topic configured on `modelParams.streamingTopic`. The topic is required for streaming runs; calling `run(agent, input, { stream: true })` without a configured topic throws before any Activity is scheduled.

Streaming requires a `streamingTopic`. Set it on the `modelParams` of the plugin registered on the **Client** — the Client interceptor injects the config header into every Workflow-starting call:

```ts
const plugin = new OpenAIAgentsPlugin({
  modelProvider: new OpenAIProvider(),
  modelParams: { streamingTopic: 'events', streamingBatchInterval: '100ms' },
});

const client = new Client({ connection, plugins: [plugin] });
```

Workflows started without that Client — by a Schedule or the Temporal UI/CLI — receive no config header. Supply Workflow-authored defaults through the runner's `defaultModelParams`; unlike the header, these can carry a function-form `summary`. Host a `WorkflowStream` in the Workflow to receive the publishes:

```ts
import { Agent } from '@openai/agents-core';
import { TemporalOpenAIRunner } from '@temporalio/openai-agents/workflow';
import { WorkflowStream } from '@temporalio/workflow-streams/workflow';

export async function streamingWorkflow(prompt: string): Promise<string> {
  new WorkflowStream();
  const agent = new Agent({ name: 'Assistant', instructions: '...' });
  const runner = new TemporalOpenAIRunner({ defaultModelParams: { streamingTopic: 'events' } });
  const result = await runner.run(agent, prompt, { stream: true });
  for await (const event of result) {
    if (event.type === 'raw_model_stream_event' && event.data.type === 'output_text_delta') {
      // event.data.delta — incremental text
    }
  }
  return result.finalOutput ?? '';
}
```

The two layers combine per field: the Client's `modelParams` overrides the runner's `defaultModelParams`.

External subscribers receive the unwrapped native model events directly:

```ts
import { WorkflowStreamClient } from '@temporalio/workflow-streams/client';

for await (const item of WorkflowStreamClient.create(client, workflowId).topic('events').subscribe()) {
  // item.data — native model stream event
}
```

The hosted `WorkflowStream` retains every published event on the Workflow heap and in history until `truncate(upToOffset)` is called. A streaming agent publishes many events per run, so a long-running or high-volume Workflow that never truncates will eventually hit Temporal's Workflow history size limits. Call `truncate(upToOffset)` periodically to keep the heap and history bounded; see [`@temporalio/workflow-streams`](../workflow-streams/README.md) for the offset model and batching.

Streaming is incompatible with `useLocalActivity`, which supports neither Activity heartbeats nor the Workflow Stream signal channel. See [`@temporalio/workflow-streams`](../workflow-streams/README.md) for the publisher/subscriber API and delivery semantics.

### Sessions

Use `WorkflowSafeMemorySession` for conversation history stored on the Workflow heap and rebuilt by replay. This replaces the upstream `MemorySession`, which is not replay safe because it depends on host process state.

```ts
import { Agent } from '@openai/agents-core';
import { TemporalOpenAIRunner, WorkflowSafeMemorySession } from '@temporalio/openai-agents/workflow';

export async function chatWorkflow(prompts: string[]): Promise<string[]> {
  const agent = new Agent({
    name: 'ChatAgent',
    instructions: 'Use the conversation history to answer.',
    model: 'gpt-4o-mini',
  });
  const runner = new TemporalOpenAIRunner();
  const session = new WorkflowSafeMemorySession();

  const replies: string[] = [];
  for (const prompt of prompts) {
    const result = await runner.run(agent, prompt, { session });
    replies.push(result.finalOutput ?? '');
  }
  return replies;
}
```

`WorkflowSafeMemorySession` history lives on the Workflow heap and is rebuilt by replay within a single run. It does **not** automatically survive `continueAsNew` — a continued run starts with an empty session. To carry history across a continue-as-new boundary, capture the items and re-seed the new run's session via the constructor's `initialItems`:

```ts
// 1. Before continuing, capture the current history:
const items = await session.getItems();
await continueAsNew(/* ...your Workflow args..., */ items);

// 2. The continued run declares a Workflow parameter to receive those items,
//    and re-seeds the session from them:
const session = new WorkflowSafeMemorySession({ initialItems: items });
```

## Worker and Client plugin setup

The Worker plugin does four things:

- Registers the model Activity used by Workflow-side model calls.
- Registers Activities for configured MCP server providers.
- Adds Workflow, Activity, and Nexus interceptors for trace propagation.
- Installs Workflow bundle polyfills required by the OpenAI Agents SDK.

The Client plugin injects the OpenAI Agents config header into Workflow-starting calls. Attach one `OpenAIAgentsPlugin` instance per Client or Connection configuration. If multiple instances are chained, the last config header wins.

`modelParams` controls scheduling for the model Activity:

```ts
const plugin = new OpenAIAgentsPlugin({
  modelProvider: new OpenAIProvider(),
  modelParams: {
    startToCloseTimeout: '30s',
    retry: { maximumAttempts: 5, initialInterval: '1s' },
    useLocalActivity: false,
  },
});
```

See `ModelActivityOptions` for the public field list. `summary` can be a string in plugin config; `ModelSummaryProvider` functions are intentionally not serialized into Workflow headers.

## Tools

Inline function tools, hosted tools, Activity-backed tools, Nexus operation tools, nested agent tools, and MCP tools can all be used from a Temporal-backed agent. Any tool that does I/O must run outside the Workflow sandbox, usually through an Activity or Nexus Operation.

### Activity-backed tools

Use `activityAsTool` for HTTP calls, database access, file system work, or other I/O. The tool name must match a registered Activity.

```ts
import { Agent } from '@openai/agents-core';
import { activityAsTool } from '@temporalio/openai-agents/workflow';
import type * as activities from './activities';

const weatherTool = activityAsTool<typeof activities.getWeather>(
  {
    name: 'getWeather',
    description: 'Get the weather for a city',
    parameters: {
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location'],
      additionalProperties: false,
    },
  },
  {
    startToCloseTimeout: '10s',
    retryPolicy: { maximumAttempts: 3 },
  }
);

const agent = new Agent({
  name: 'WeatherAgent',
  instructions: 'Use the getWeather tool when asked about weather.',
  model: 'gpt-4o-mini',
  tools: [weatherTool],
});
```

The generic type is compile-time only. At runtime the Activity is invoked by name through `proxyActivities`.

### Inline and hosted tools

For deterministic computation, use `tool()` from `@openai/agents-core` directly. Inline tools run in the Workflow sandbox and must not perform I/O, consume nondeterministic randomness, or read wall-clock time beyond Temporal's deterministic replacements.

Hosted tools from `@openai/agents-openai`, such as `webSearchTool()`, run server-side through the model provider during the model Activity.

```ts
import { Agent, tool } from '@openai/agents-core';
import { webSearchTool } from '@openai/agents-openai';

const addNumbers = tool({
  name: 'addNumbers',
  description: 'Add two numbers',
  parameters: {
    type: 'object' as const,
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'] as const,
    additionalProperties: false as const,
  },
  execute: async (args) => String((args as { a: number; b: number }).a + (args as { a: number; b: number }).b),
});

const agent = new Agent({
  name: 'SearchAgent',
  instructions: 'You have web search and arithmetic.',
  model: 'gpt-4o-mini',
  tools: [addNumbers, webSearchTool()],
});
```

### Nexus operation tools

Use `nexusOperationAsTool` to expose a [Nexus](https://docs.temporal.io/nexus) Operation as an agent tool. The Workflow starts the Operation through a Nexus client and feeds the stringified result back to the agent.

```ts
import { Agent } from '@openai/agents-core';
import { nexusOperationAsTool } from '@temporalio/openai-agents/workflow';
import * as nexus from 'nexus-rpc';

const weatherService = nexus.service('weather', {
  getWeather: nexus.operation<{ location: string }, { tempC: number }>(),
});

const weatherTool = nexusOperationAsTool(
  weatherService.operations.getWeather,
  {
    name: 'getWeather',
    description: 'Get the weather for a city',
    parameters: {
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location'],
      additionalProperties: false,
    },
  },
  { service: weatherService, endpoint: 'weather-endpoint' }
);

const agent = new Agent({
  name: 'WeatherAgent',
  instructions: 'Use the weather tool.',
  model: 'gpt-4o-mini',
  tools: [weatherTool],
});
```

### Nested agent tools

Use `agentAsTool` to expose another `Agent` as a tool while keeping nested model calls durable:

```ts
import { Agent } from '@openai/agents-core';
import { agentAsTool } from '@temporalio/openai-agents/workflow';

const specialist = new Agent({
  name: 'Specialist',
  instructions: 'Answer precisely.',
  model: 'gpt-4o-mini',
});

const triage = new Agent({
  name: 'Triage',
  instructions: 'Delegate specialist questions.',
  model: 'gpt-4o-mini',
  tools: [
    agentAsTool(specialist, {
      toolName: 'ask_specialist',
      toolDescription: 'Ask the specialist agent',
    }),
  ],
});
```

Nested approval interruptions are not supported. If a nested run pauses for approval, the tool invocation fails with `ApplicationFailure` type `NestedAgentInterruption`.

## MCP servers

The integration supports stateless and stateful [Model Context Protocol](https://modelcontextprotocol.io/) servers.

### Stateless MCP servers

Use stateless servers when each tool call is independent. Register a provider on the Worker:

```ts
import { MCPServerStreamableHttp } from '@openai/agents-core';
import { OpenAIProvider } from '@openai/agents-openai';
import { OpenAIAgentsPlugin, StatelessMCPServerProvider } from '@temporalio/openai-agents';

const unitConversionMcp = new StatelessMCPServerProvider(
  'unitConversion',
  (factoryArgument?) =>
    new MCPServerStreamableHttp({ name: 'unitConversion', url: 'https://mcp.example.com/unit-conversion' })
);

const plugin = new OpenAIAgentsPlugin({
  modelProvider: new OpenAIProvider(),
  mcpServerProviders: [unitConversionMcp],
});
```

Reference the same provider name from Workflow code:

```ts
import { Agent } from '@openai/agents-core';
import { statelessMcpServer, TemporalOpenAIRunner } from '@temporalio/openai-agents/workflow';

export async function mcpWorkflow(query: string): Promise<string> {
  const agent = new Agent({
    name: 'UnitConverter',
    instructions: 'Use unit conversion tools to answer questions.',
    model: 'gpt-4o-mini',
    mcpServers: [statelessMcpServer('unitConversion')],
  });

  const result = await new TemporalOpenAIRunner().run(agent, query);
  return result.finalOutput ?? '';
}
```

### Stateful MCP servers

Use stateful servers when a persistent connection or session is required. The plugin starts a dedicated in-process Worker pinned to a per-run Task Queue and routes MCP operations to it.

```ts
import { MCPServerStreamableHttp } from '@openai/agents-core';
import { OpenAIProvider } from '@openai/agents-openai';
import { OpenAIAgentsPlugin, StatefulMCPServerProvider } from '@temporalio/openai-agents';
import { NativeConnection } from '@temporalio/worker';

const connection = await NativeConnection.connect();
const dbMcp = new StatefulMCPServerProvider(
  'database',
  (factoryArgument?) => new MCPServerStreamableHttp({ name: 'database', url: 'https://mcp.example.com/database' }),
  connection
);

const plugin = new OpenAIAgentsPlugin({
  modelProvider: new OpenAIProvider(),
  mcpServerProviders: [dbMcp],
});
```

In the Workflow, call `connect()` before use and `cleanup()` in a `finally` block:

```ts
import { Agent } from '@openai/agents-core';
import { statefulMcpServer, TemporalOpenAIRunner } from '@temporalio/openai-agents/workflow';

export async function statefulMcpWorkflow(prompt: string): Promise<string> {
  const server = statefulMcpServer('database');
  await server.connect();
  try {
    const agent = new Agent({
      name: 'DbAgent',
      instructions: 'You have database access.',
      model: 'gpt-4o-mini',
      mcpServers: [server],
    });
    const result = await new TemporalOpenAIRunner().run(agent, prompt);
    return result.finalOutput ?? '';
  } finally {
    await server.cleanup();
  }
}
```

Dedicated Worker startup and heartbeat failures surface as `ApplicationFailure` type (exported as `DEDICATED_WORKER_FAILURE_TYPE`).

## Tracing

OpenAI Agents SDK tracing works across Client, Workflow, Activity, Nexus, and MCP boundaries. Workflow replay does not duplicate spans.

### OpenAI hosted traces

Enable the upstream hosted exporter before constructing the plugin:

```ts
import { OpenAITracingExporter } from '@openai/agents-openai';
import { addTraceProcessor, BatchTraceProcessor } from '@openai/agents-core';

addTraceProcessor(new BatchTraceProcessor(new OpenAITracingExporter()));
```

**Register this processor in the Worker process, not inside Workflow code.**

**Warning**: Using `setDefaultOpenAITracingExporter()` after constructing the plugin will break plugin internals. Either call it before constructing the plugin, or use `addTraceProcessor` as described above.

### OpenTelemetry

Install `@opentelemetry/sdk-trace-base` before importing the OTel subpath:

```bash
# Or `pnpm add`/`yarn add`
npm install @opentelemetry/sdk-trace-base
```

```ts
import { trace } from '@opentelemetry/api';
import { OpenAIProvider } from '@openai/agents-openai';
import { OpenAIAgentsPlugin } from '@temporalio/openai-agents';
import { createTracerProvider } from '@temporalio/openai-agents/otel';

trace.setGlobalTracerProvider(createTracerProvider());

const plugin = new OpenAIAgentsPlugin({
  modelProvider: new OpenAIProvider(),
  interceptorOptions: { useOtelInstrumentation: true },
});
```

Use `createTracerProvider` from this package for replay-safe OTel ID generation. If you need a different provider class, configure it with `TemporalIdGenerator` and mark it before registering it:

```ts
import { trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { markReplaySafeTracerProvider, TemporalIdGenerator } from '@temporalio/openai-agents/otel';

const provider = markReplaySafeTracerProvider(
  new NodeTracerProvider({
    idGenerator: new TemporalIdGenerator(),
  })
);

trace.setGlobalTracerProvider(provider);
```

Only mark providers that use `TemporalIdGenerator`; the marker opts into the plugin's replay-safety checks.

### Temporal orchestration spans

Set `addTemporalSpans: true` to emit `temporal:*` agent-SDK spans for orchestration operations such as Workflow starts, Signals, Queries, Updates, Activities, child Workflows, Nexus Operations, and continue-as-new:

```ts
const plugin = new OpenAIAgentsPlugin({
  modelProvider: new OpenAIProvider(),
  interceptorOptions: { addTemporalSpans: true },
});
```

These spans are agent-SDK spans, so they reach the hosted OpenAI dashboard, custom `TracingProcessor`s, and OTel when enabled.

## Pre-built workflow bundles

When using `bundleWorkflowCode`, pass the plugin to the bundler as well as to the Worker. The bundler hook installs Workflow-side Web API polyfills and registers the Workflow trace interceptor.

```ts
import { OpenAIProvider } from '@openai/agents-openai';
import { OpenAIAgentsPlugin } from '@temporalio/openai-agents';
import { bundleWorkflowCode } from '@temporalio/worker';

const plugin = new OpenAIAgentsPlugin({ modelProvider: new OpenAIProvider() });
const bundle = await bundleWorkflowCode({
  workflowsPath: require.resolve('./workflows'),
  plugins: [plugin],
});
```

## Import paths

Most applications use two import paths: `@temporalio/openai-agents` in Worker and Client code, and `@temporalio/openai-agents/workflow` in Workflow code. The other subpaths are for tracing setup or manual Worker wiring.

| Import path                                      | Import from      | Use for                                                     |
| :----------------------------------------------- | :--------------- | :---------------------------------------------------------- |
| `@temporalio/openai-agents`                      | Worker or Client | Plugin setup, MCP providers, model option types             |
| `@temporalio/openai-agents/workflow`             | Workflow         | Runner, Workflow-safe tools, sessions, MCP handles          |
| `@temporalio/openai-agents/otel`                 | Worker or Client | Replay-safe OpenTelemetry setup                             |
| `@temporalio/openai-agents/workflow-interceptor` | Worker bundling  | Manual `workflowInterceptorModules` wiring without a plugin |

`@temporalio/openai-agents` exports `OpenAIAgentsPlugin`, MCP provider classes, model option types, and `DEDICATED_WORKER_FAILURE_TYPE`. `OpenAIAgentsTraceClientInterceptor` is also public for Clients that need manual interceptor wiring instead of plugin registration.

`@temporalio/openai-agents/workflow` exports Workflow-safe APIs: `TemporalOpenAIRunner`, `WorkflowSafeMemorySession`, `activityAsTool`, `nexusOperationAsTool`, `agentAsTool`, `statelessMcpServer`, `statefulMcpServer`, related option/definition types, and `DEDICATED_WORKER_FAILURE_TYPE`.

`@temporalio/openai-agents/otel` exports `createTracerProvider`, `TemporalIdGenerator`, `markReplaySafeTracerProvider`, `isReplaySafeTracerProvider`, and `TemporalOpenAIAgentsTracerProviderOptions`. Install optional peer dependency `@opentelemetry/sdk-trace-base` only when you use this OTel integration.

`@temporalio/openai-agents/workflow-interceptor` exports the Workflow trace interceptor module. The plugin registers it automatically; import this path only when assembling Worker interceptor modules yourself.

There is no public TypeScript testing subpath.

## Feature support

Any OpenAI Agents SDK `ModelProvider` can be passed as `modelProvider`. The provider runs in the model Activity, never inside the Workflow sandbox.

| Feature                 | Status                   | Notes                                                                                          |
| :---------------------- | :----------------------- | :--------------------------------------------------------------------------------------------- |
| Multi-turn agents       | Supported                | Agent loop runs durably in the Workflow                                                        |
| Handoffs                | Supported                | `Agent` and `handoff()` forms                                                                  |
| Inline function tools   | Supported                | Must be deterministic                                                                          |
| Activity-backed tools   | Supported                | Via `activityAsTool()`                                                                         |
| Nexus operation tools   | Supported                | Via `nexusOperationAsTool()`                                                                   |
| Nested agent tools      | Supported                | Via `agentAsTool()`                                                                            |
| Hosted tools            | Supported                | Executed server-side by the model provider                                                     |
| Stateless MCP servers   | Supported                | Via `StatelessMCPServerProvider` and `statelessMcpServer()`                                    |
| Stateful MCP servers    | Supported                | Via `StatefulMCPServerProvider` and `statefulMcpServer()`                                      |
| Sessions                | Supported                | Via `WorkflowSafeMemorySession`; upstream `MemorySession` is rejected                          |
| Run state and approvals | Supported                | Serialize with `result.state.toString()` and rehydrate with `RunState.fromString`              |
| Guardrails              | Supported                | Guardrail callbacks must be deterministic                                                      |
| Tracing                 | Supported                | OpenAI hosted traces, custom `TracingProcessor`s, OTel, and optional `temporal:*` spans        |
| Agent context           | Supported                | Activity tools receive a copy                                                                  |
| `continueAsNew`         | Supported                | Plugin config propagates to the continuation                                                   |
| Child Workflows         | Supported                | Plugin config propagates to children                                                           |
| Local Activities        | Supported                | Set `useLocalActivity: true` in `modelParams`                                                  |
| Model override per run  | Supported                | `runConfig.model` accepts a string model name                                                  |
| Streaming               | Supported (experimental) | `run(agent, input, { stream: true })`; requires `streamingTopic` and a hosted `WorkflowStream` |
| Voice agents            | Not supported            |                                                                                                |
