# @temporalio/langsmith — LangSmith tracing for Temporal

This plugin makes [LangSmith](https://docs.smith.langchain.com/) observability
work inside Temporal Workflows and Activities **without changing your existing
instrumentation**. Code you already trace with LangSmith's native `traceable`
keeps working when you move it into a Workflow or Activity body — you only add
the plugin to your `Client` and `Worker`.

This plugin is built on Temporal's Plugin API, which is experimental; its APIs
may change in a future release.

It handles the parts that are otherwise hard:

- **Replay safety.** Workflows replay history; a naive tracer re-emits every run
  on every replay and floods your project with duplicates. This plugin emits
  runs with deterministic IDs out-of-isolate via a Temporal Sink that does not
  fire during replay.
- **Run parenting across boundaries.** A trace started on the client threads
  through `workflow → activity → child-workflow → Nexus` so the runs nest the
  way you expect, instead of fragmenting into disconnected roots.

## Install

```bash
npm install @temporalio/langsmith langsmith
```

`langsmith` is a peer dependency — install the version your project already uses.

## Enable tracing

Tracing is **off by default**, matching the `langsmith` library: the plugin
emits nothing unless LangSmith tracing is enabled in the worker/client process
environment. Enable it with LangSmith's standard environment variables:

```bash
export LANGSMITH_TRACING=true
export LANGSMITH_API_KEY="<your key>"
```

The plugin reads the same flags LangSmith itself uses (`LANGSMITH_TRACING` /
`LANGSMITH_TRACING_V2` and their `LANGCHAIN_` aliases); with none set to `true`,
tracing stays off and the plugin is a no-op.

## Hello world

Your existing LangSmith instrumentation does not change. Here a `traceable`
runs inside an Activity:

```typescript
// activities.ts
import { traceable } from 'langsmith/traceable';

const callModel = traceable(
  async (prompt: string) => {
    // ... your real model call ...
    return `answer to: ${prompt}`;
  },
  { name: 'inner_llm_call' }
);

export async function answer(prompt: string): Promise<string> {
  return callModel(prompt);
}
```

```typescript
// workflows.ts
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from './activities';

const { answer } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

export async function GreetingWorkflow(prompt: string): Promise<string> {
  return answer(prompt);
}
```

The only new code is the plugin registration on the `Client` and the `Worker`:

```typescript
// worker.ts
import { Worker } from '@temporalio/worker';
import { Client } from '@temporalio/client';
import { Client as LangSmithClient } from 'langsmith';
import { LangSmithPlugin } from '@temporalio/langsmith';
import * as activities from './activities';

const langsmith = new LangSmithClient(); // reads LANGSMITH_API_KEY from the env

// In TypeScript the Client and Worker are configured independently, so add the
// plugin to each. (Construct one plugin instance and share it.)
const plugin = new LangSmithPlugin({ client: langsmith, addTemporalRuns: true });

const client = new Client({ plugins: [plugin] });

const worker = await Worker.create({
  taskQueue: 'greeting',
  workflowsPath: require.resolve('./workflows'),
  activities,
  plugins: [plugin],
});

await worker.run();
```

```typescript
// starter.ts — start the workflow from inside your own trace
import { traceable } from 'langsmith/traceable';

const pipeline = traceable(
  async () => {
    return client.workflow.execute(GreetingWorkflow, {
      taskQueue: 'greeting',
      workflowId: 'greeting-1',
      args: ['hello'],
    });
  },
  { name: 'user_pipeline' }
);

await pipeline();
```

With `addTemporalRuns: true`, the resulting trace nests like this:

```
user_pipeline
  StartWorkflow:GreetingWorkflow
  RunWorkflow:GreetingWorkflow
    StartActivity:answer
    RunActivity:answer
      inner_llm_call
```

Set `addTemporalRuns: false` (the default) to emit only your own `traceable`
runs — the trace context still propagates across boundaries, so they nest
correctly, but no `StartWorkflow:` / `RunActivity:` scaffolding is added:

```
user_pipeline
  inner_llm_call
```

## Options

| Option            | Default           | Meaning                                                                                                                                        |
| ----------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `client`          | `new Client()`    | The LangSmith client runs are emitted to. Lives only in the worker/client process — it is never serialized or sent across a Temporal boundary. |
| `addTemporalRuns` | `false`           | Emit first-class runs for Temporal operations (`StartWorkflow:`, `RunActivity:`, `HandleSignal:`, …) in addition to your `traceable` runs.     |
| `projectName`     | LangSmith default | Target LangSmith project for emitted runs.                                                                                                     |
| `tags`            | —                 | Tags attached to every run the plugin emits.                                                                                                   |
| `metadata`        | —                 | Metadata merged into every run the plugin emits. Credential-looking keys are scrubbed before emission.                                         |

The LangSmith API key is never accepted as a plugin option and never crosses a
Temporal boundary. Supply a pre-constructed `Client` (which reads
`LANGSMITH_API_KEY` from the process environment) or let the plugin build a
default client from the environment.

## Where `traceable` works

`traceable` from `langsmith/traceable` works **unchanged** in every position
below. Each row is exercised by the plugin's test suite.

| Position                                         | Works? | Notes                                                                                                                                                              |
| ------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Client side, before `client.workflow.start(...)` | ✅     | The trace propagates into the workflow; `RunWorkflow:` nests under your run.                                                                                       |
| Inside an **Activity** body                      | ✅     | Runs in the real worker process. Nests under `RunActivity:` (or under the propagated parent when `addTemporalRuns: false`).                                        |
| Inside a **Workflow** body                       | ✅     | Replay-safe: deterministic IDs, emitted out-of-isolate, suppressed on replay. Works whether or not a parent trace is propagated in.                                |
| Inside **signal / query / update** handlers      | ✅     | Handler-body `traceable` runs nest under the handler's run (workflow-body semantics). Temporal-internal queries (`__temporal*`, `__stack_trace`) are never traced. |

Inside a Workflow, parent resolution rides the SDK-provided `AsyncLocalStorage`
the worker injects onto the workflow-sandbox global, so context propagates
across `await` boundaries and `Promise.all(...)` fan-out exactly as it does
outside the isolate — the same deterministic run tree replays identically.

## Process-wide effects to be aware of

- **Workflow context provider.** Loading the plugin's workflow interceptor
  module installs a global LangSmith async-context provider inside the workflow
  isolate (via `AsyncLocalStorageProviderSingleton.initializeGlobalInstance`),
  backed by the SDK-provided `AsyncLocalStorage`. This is what lets unchanged
  `traceable` calls find their parent inside a Workflow. It is scoped to the
  workflow bundle and does not affect your client/worker process context.

## Composing with other plugins

Register observability **first** (outermost) so it observes everything beneath
it, then governance, then agent-framework plugins:

```typescript
const worker = await Worker.create({
  taskQueue: 'tq',
  workflowsPath: require.resolve('./workflows'),
  activities,
  plugins: [
    new LangSmithPlugin({ client: langsmith }), // observability — first
    // new GovernancePlugin(...),
    // new AgentFrameworkPlugin(...),
  ],
});
```

The plugin is safe to register on both the `Client` and the `Worker`; it
de-duplicates its own interceptors and sinks, so a worker built from a
plugin-configured client will not double-instrument.

## License

MIT
