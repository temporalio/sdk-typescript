# @temporalio/tool-registry

LLM tool-calling primitives for Temporal activities — define tools once, use with
Anthropic or OpenAI.

## Before you start

A Temporal Activity is a function that Temporal monitors and retries automatically on failure. Temporal streams progress between retries via heartbeats — that's the mechanism `agenticSession` uses to resume a crashed LLM conversation mid-turn.

`runToolLoop` works standalone in any async function — no Temporal server needed. Add `agenticSession` only when you need crash-safe resume inside a Temporal activity.

`agenticSession` requires a running Temporal worker — it reads and writes heartbeat state from the active activity context. Use `runToolLoop` standalone for scripts, one-off jobs, or any code that runs outside a Temporal worker.

New to Temporal? → https://docs.temporal.io/develop

## Install

```bash
npm install @temporalio/tool-registry @anthropic-ai/sdk   # Anthropic
npm install @temporalio/tool-registry openai              # OpenAI
```

## Quickstart

Tool definitions use [JSON Schema](https://json-schema.org/understanding-json-schema/) for `input_schema`. The quickstart uses a single string field; for richer schemas refer to the JSON Schema docs.

```typescript
import { ToolRegistry, runToolLoop } from '@temporalio/tool-registry';

export async function analyzeCode(prompt: string): Promise<string[]> {
  const issues: string[] = [];
  const tools = new ToolRegistry();

  tools.define(
    {
      name: 'flag_issue',
      description: 'Flag a problem found in the analysis',
      input_schema: {
        type: 'object',
        properties: { description: { type: 'string' } },
        required: ['description'],
      },
    },
    (inp: Record<string, unknown>) => {
      issues.push(inp['description'] as string);
      return 'recorded'; // this string is sent back to the LLM as the tool result
    }
  );

  await runToolLoop({
    provider: 'anthropic', // reads ANTHROPIC_API_KEY from environment; or use 'openai'
    system: 'You are a code reviewer. Call flag_issue for each problem you find.',
    prompt,
    tools,
  });

  return issues;
}
```

## Feature matrix

| Feature | `@temporalio/tool-registry` | `@temporalio/ai-sdk` |
|---|---|---|
| Anthropic (claude-*) | ✓ | ✗ |
| OpenAI (gpt-*) | ✓ | ✓ (via AI SDK) |
| MCP tool wrapping | ✓ | ✓ |
| Crash-safe heartbeat resume | ✓ (via `agenticSession`) | ✗ |
| AI SDK provider abstraction | ✗ | ✓ |

Use `@temporalio/ai-sdk` when you need the Vercel AI SDK's provider abstraction (multi-provider flexibility via AI SDK).
Use `@temporalio/tool-registry` for direct Anthropic support, multi-provider
flexibility, or crash-safe agentic sessions.

## Sandbox configuration

You need this if you register both workflows and activities on the same `Worker` instance. If your activities run on a dedicated worker (no `workflowsPath`), skip this section.

The Temporal workflow bundler excludes third-party packages. Use `ToolRegistryPlugin`
so that activities using LLM libraries can run on the same worker as bundled workflows:

```typescript
import { Worker } from '@temporalio/worker';
import { ToolRegistryPlugin } from '@temporalio/tool-registry';

const worker = await Worker.create({
  connection,
  namespace: 'default',
  taskQueue: 'my-queue',
  plugins: [new ToolRegistryPlugin({ provider: 'anthropic' })],
  workflowsPath: require.resolve('./workflows'),
  activities,
});
```

## MCP integration

MCP tool wrapping is supported via `ToolRegistry.fromMcpTools()`. See the MCP integration guide for a complete example including server setup.

### Selecting a model

The default model is `"claude-sonnet-4-6"` (Anthropic) or `"gpt-4o"` (OpenAI). Pass `model` to `runToolLoop`:

```typescript
await runToolLoop({
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  system: '...',
  prompt,
  tools,
});
```

Model IDs are defined by the provider — see Anthropic or OpenAI docs for current names.

### OpenAI

```typescript
await runToolLoop({
  provider: 'openai', // reads OPENAI_API_KEY from environment
  system: '...',
  prompt,
  tools,
});
```

## Crash-safe agentic sessions

For multi-turn LLM conversations that must survive activity retries, use
`agenticSession`. It saves conversation history via `activity.heartbeat()` on every
turn and restores it automatically on retry.

```typescript
export async function longAnalysis(prompt: string): Promise<object[]> {
  let issues: object[] = [];
  await agenticSession(async (session) => {
    const tools = new ToolRegistry();
    tools.define(
      { name: 'flag', description: '...', input_schema: { type: 'object' } },
      (inp: Record<string, unknown>) => {
        session.issues.push(inp);
        return 'ok'; // this string is sent back to the LLM as the tool result
      }
    );
    await session.runToolLoop({
      registry: tools,
      provider: 'anthropic', // reads ANTHROPIC_API_KEY from environment
      system: '...',
      prompt,
    });
    issues = session.issues; // capture after loop completes
  });
  return issues;
}
```

## Testing without an API key

Use `MockProvider` and `ResponseBuilder` to test tool-calling logic without hitting a live API:

```typescript
import { ToolRegistry } from '@temporalio/tool-registry';
import { MockProvider, ResponseBuilder } from '@temporalio/tool-registry/testing';

const tools = new ToolRegistry();
tools.define(
  { name: 'flag', description: 'd', input_schema: { type: 'object' } },
  (inp: Record<string, unknown>) => 'ok' // this string is sent back to the LLM as the tool result
);

const provider = new MockProvider([
  ResponseBuilder.toolCall('flag', { description: 'stale API' }),
  ResponseBuilder.done('done'),
]);
const messages = [{ role: 'user', content: 'analyze' }];
await provider.runLoop(messages, tools);
assert(messages.length > 2);
```

## Integration testing with real providers

To run the integration tests against live Anthropic and OpenAI APIs:

```bash
RUN_INTEGRATION_TESTS=1 \
  ANTHROPIC_API_KEY=sk-ant-... \
  OPENAI_API_KEY=sk-proj-... \
  npm test
```

Tests skip automatically when `RUN_INTEGRATION_TESTS` is unset. Real API calls
incur billing — expect a few cents per full test run.

## Storing application results

`session.issues` accumulates application-level results during the tool loop.
Elements are serialized to JSON inside each heartbeat checkpoint — they must be
plain maps/dicts with JSON-serializable values. A non-serializable value raises
a non-retryable `ApplicationError` at heartbeat time rather than silently losing
data on the next retry.

### Storing typed results

Convert your domain type to a plain dict at the tool-call site and back after
the session:

```typescript
interface Issue { type: string; file: string; }

// Inside tool handler:
session.issues.push({ type: 'smell', file: 'foo.ts' } satisfies Issue);

// After session:
const issues = session.issues as Issue[];
```

## Per-turn LLM timeout

Individual LLM calls inside the tool loop are unbounded by default. A hung HTTP
connection holds the activity open until Temporal's `ScheduleToCloseTimeout`
fires — potentially many minutes. Set a per-turn timeout on the provider client:

```typescript
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: '...', timeout: 30_000 }); // ms
await session.runToolLoop({ ..., client });
```

Recommended timeouts:

| Model type | Recommended |
|---|---|
| Standard (Claude 3.x, GPT-4o) | 30 s |
| Reasoning (o1, o3, extended thinking) | 300 s |
