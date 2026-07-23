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

Peer dependency: `@google/adk` `^1.2.0` and its `@google/genai`. Provide Gemini
credentials to the Worker as usual, for example with `GOOGLE_API_KEY` or
`GEMINI_API_KEY`.

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

## Operational notes

- Register `GoogleAdkPlugin` on the Worker. Passing it directly to `Client` does
  not register the model/MCP Activities. If composing plugins, place
  observability and governance plugins before this one.
- Model calls use Temporal retries. The plugin disables nested GenAI SDK retries
  for model requests and honors `retry-after` where available.
- Heartbeats are sent only when the Activity options include `heartbeatTimeout`.
- Streaming topic delivery is at-least-once. The deterministic Workflow value is
  the Activity result, not the stream side channel.
- `BaseLlm.connect` live BIDI streaming is not supported inside Workflows.
- Any ADK extension point that performs I/O must be moved behind an Activity.

## License

MIT
