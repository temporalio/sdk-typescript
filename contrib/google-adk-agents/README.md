# @temporalio/google-adk-agents

Run [Google Agent Development Kit](https://github.com/google/adk-js) (`@google/adk`)
agents as durable [Temporal](https://temporal.io) Workflows.

Your ADK agent graph — agents, tools, plugins, and ADK 2.0's workflow (graph)
runtime — runs inside the Workflow and replays deterministically. The plugin
routes non-deterministic boundaries out to Activities:

- every **model call** (`generateContentAsync`) becomes a retryable, observable
  Activity,
- every **MCP tool call**, resource listing and resource read becomes an Activity,
- an **Activity** can be a graph node (`activityNode`) or a tool (`activityAsTool`).

Regular ADK `FunctionTool`s still run in the Workflow. If a tool performs I/O,
wrap an existing Temporal Activity with `activityAsTool`.

## Install

```bash
npm install @temporalio/google-adk-agents
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
change; raw model strings (`model: 'gemini-2.5-flash'`) now work inside a Workflow
without `TemporalModel` (see [Model routing](#model-routing)).

## Hello world

Register `GoogleAdkPlugin` on the Worker. Everything else is ordinary ADK code.

### `workflows.ts`

```typescript
import { InMemoryRunner, LlmAgent, isFinalResponse, stringifyContent } from '@google/adk';
import { TemporalModel } from '@temporalio/google-adk-agents/workflow';

export async function askAgent(prompt: string): Promise<string> {
  const agent = new LlmAgent({
    name: 'assistant',
    // Optional — a raw 'gemini-2.5-flash' string works too; wrap it to set
    // Activity options (timeouts, retries, streaming) for the model calls.
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

ADK turns a model error into an event rather than rethrowing it, so a run can
finish normally on a failure nobody saw; the plugin raises such a failure as the
Workflow (or the Update handler that ran the turn) returns. What counts as the
recovery is the same agent answering later in the same ADK invocation: a node
`retryConfig` that re-runs the agent, or a graph that activates the node again,
leaves nothing to raise. Another agent answering does not clear it, and neither
does a later turn, which is a new question rather than a second go at the one
that failed.

### Model routing

Inside a Workflow, ADK's built-in model classes (`Gemini`, `ApigeeLlm`) cannot run:
they call the network from the sandbox. The plugin therefore re-registers their
model-name patterns in the Workflow's `LLMRegistry` to a `TemporalModel`, so an
agent configured with a raw string — `model: 'gemini-2.5-flash'`,
`model: 'apigee/…'` — is durable without any change, using `TemporalModel`'s
default Activity options (a one-minute `startToCloseTimeout`, no streaming). Wrap
the string in `new TemporalModel(name, options)` to customize.

The Worker is untouched: there the real class runs inside the model Activity, so
`GoogleAdkPluginOptions.modelProvider` still resolves the same names.

`RoutedLlm` holds model _instances_, so build it from `TemporalModel`s. Set
`autoRouteModels: false` on the plugin only if you register your own sandbox-safe
`BaseLlm` for one of those patterns.

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

Gate the toolset's tools behind human approval with
`requireConfirmation` — see [Durable human-in-the-loop](#durable-human-in-the-loop).

### MCP resources

ADK 2.0's `MCPToolset` lists and reads MCP resources. `TemporalMCPToolset` does
the same through `<name>-listResources` / `<name>-readResource` Activities, and
`loadMcpResourceTool` is the counterpart of ADK's `LoadMcpResourceTool`: the model
asks for resources by name, and on the next model call the tool appends their
contents to the request.

```typescript
const toolset = new TemporalMCPToolset({ name: 'filesystem' });
const agent = new LlmAgent({
  name: 'reader',
  model: new TemporalModel('gemini-2.5-flash'),
  tools: [toolset, loadMcpResourceTool(toolset)],
});
```

ADK re-lists the server's resources before every model call; the plugin lists
once per tool instance instead (each listing is an Activity), and
`loadMcpResourceTool(toolset, { refreshResourceList: true })` restores ADK's
behavior. As in ADK, resource contents are appended to one request only — the
model must ask again to see them on a later turn — and a failed listing or read
is logged and skipped, not raised. A factory-supplied toolset must be an
`MCPToolset` (or expose `listResources` / `readResource`) for resources to work;
connection params always do.

Because they are skipped rather than raised, resource reads are best-effort and
bounded: `listResources` and `readResource` default `activity.retry.maximumAttempts`
to 3, where a tool call keeps Temporal's unlimited default. Without that bound an
unreachable server would retry behind the model turn forever and never reach the
skip path. Set `activity: { retry: { maximumAttempts: n } }` on the toolset to
choose your own, or `maximumAttempts: Number.POSITIVE_INFINITY` for unlimited.
`0` is not a way to say unlimited here: the SDK rejects it with a `ValueError`.

A cancelled listing or read ends its Activity cancelled. ADK's own
`MCPToolset.listResources()` / `readResource(name)` take no `AbortSignal`, so for
connection params and for a factory that returns an unmodified `MCPToolset` the
plugin issues those MCP requests itself, over the toolset's own session manager,
with the Activity's signal: a cancel aborts the pending request and sends the
server `notifications/cancelled`. Any other toolset with resource methods is
raced against the signal instead, so the Activity still ends cancelled at once,
but its request runs on until the toolset's own timeout.

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
import { InMemoryRunner, JoinNode, Workflow } from '@google/adk';
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
  its single argument and the Activity's result, whatever its shape, is the
  node's output; `args` maps the input (and `NodeContext`, for state) to the
  Activity's argument list. The node's event carries the result as `output`
  only, with no `content`, so a result with a `parts` array is not taken for
  genai `Content` the way ADK's `FunctionNode` would take it. An Activity
  returning nothing (`undefined` or `null`) completes the node with a `null`
  output, so its successors receive `null`. ADK records a node as done only
  when its events carry an output, and without one a completed Activity would
  run again when a paused graph resumes.
- **Schemas.** A Zod `outputSchema` checks every result, one with a `parts`
  array included, which ADK's own check lets through as genai `Content`. A genai
  `Schema` is checked by ADK's validator, which the plugin cannot reach and which
  still lets such a result through, so give an Activity whose result can carry
  `parts` a Zod `outputSchema`. The `inputSchema` check is ADK's as it is: an
  input that is genai `Content` (the run's opening message, when it has no text
  part) is left for `args` to handle.
- **Node names.** The node is named after the Activity unless `nodeName` says
  otherwise, and the name may not contain `.`, `/` or `@`: ADK reads a node path
  back by those characters (its segments, and the run-id suffix), and a name
  containing one breaks the resume that fast-forwards a completed node.
  `activityNode` refuses one, so an Activity type such as `payments.charge` or
  `charge@customer` needs a `nodeName`.
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
  Activity and fails the node with ADK's `NodeTimeoutError` once that
  cancellation has settled, so a retry never overlaps the Activity it replaces.
  What "settled" means is the Activity's `cancellationType`: unset
  (`TRY_CANCEL`) it settles at once and the Activity winds down on its own; with
  `WAIT_CANCELLATION_COMPLETED` the node waits for the Activity to acknowledge,
  which it only does at its next heartbeat. The plugin runs this deadline
  itself, because ADK's own races the node and then abandons the unwind.
- **Fan-in.** Use a `JoinNode`: it is the node type that waits for every
  predecessor, and its input is the map from predecessor name to that node's
  output. ADK's `waitForOutput` flag is not a fan-in gate (it parks a node that
  ended with no output and no route), so `activityNode` does not expose it.
- **Resume.** ADK resumes a paused graph from the session's events: a node that
  already produced output is always fast-forwarded rather than re-run, so an
  `activityNode`'s Activity is not scheduled again. (ADK's `rerunOnResume`
  concerns a node that paused for input last turn, which an Activity node never
  does, so `activityNode` does not expose it either.) Resume is at-least-once
  for a dynamic node's body — put side effects in `activityNode` /
  `activityAsTool` children, or make them idempotent.
- `LongRunningFunctionTool`s (including a node-as-tool) cannot be used as a
  `ToolNode`; ADK rejects that.

### Durable human-in-the-loop

ADK pauses a run by emitting a long-running function call — `adk_request_input`
from a `RequestInput` node or ADK's `requestInputTool`, `adk_request_confirmation`
from a tool gated with `requireConfirmation` — and resumes when a later user
message answers it. Because the runner runs inside the Workflow, the wait is
ordinary Workflow code, and the plugin supplies the wire format:

```typescript
import { InMemoryRunner } from '@google/adk';
import type { Content, Part } from '@google/genai';
import { ApplicationFailure } from '@temporalio/common';
import { condition, defineQuery, defineUpdate, setHandler } from '@temporalio/workflow';
import {
  HITL_RESPONSE_FAILURE_TYPE,
  hitlConfirmationResponse,
  hitlInputResponse,
  pendingHitlRequests,
  type HitlConfirmation,
  type HitlRequest,
} from '@temporalio/google-adk-agents/workflow';

export const pendingQuery = defineQuery<HitlRequest[]>('pending');
export const respondUpdate = defineUpdate<void, [string, unknown]>('respond');

// `graph` is the Workflow built in the section above; any RunnableRoot works.
export async function reviewWorkflow(prompt: string): Promise<unknown> {
  let pending: HitlRequest[] = [];
  const answers = new Map<string, Part>();
  setHandler(pendingQuery, () => pending);
  // Build the response inside the handler, so a bad answer rejects the Update
  // rather than failing a Workflow Task once it is already in history.
  setHandler(respondUpdate, (interruptId, value) => {
    const request = pending.find((r) => r.interruptId === interruptId);
    if (!request) {
      throw ApplicationFailure.nonRetryable(`nothing is waiting on '${interruptId}'`, HITL_RESPONSE_FAILURE_TYPE);
    }
    answers.set(
      interruptId,
      request.kind === 'confirmation'
        ? hitlConfirmationResponse(request, value as HitlConfirmation)
        : hitlInputResponse(request, value)
    );
  });

  const runner = new InMemoryRunner({ agent: graph });
  const session = await runner.sessionService.createSession({ appName: runner.appName, userId: 'user' });
  let newMessage: Content = { role: 'user', parts: [{ text: prompt }] };
  for (;;) {
    let output: unknown;
    for await (const event of runner.runAsync({ userId: 'user', sessionId: session.id, newMessage })) {
      if (event.output !== undefined) output = event.output;
    }
    const current = await runner.sessionService.getSession({
      appName: runner.appName,
      userId: 'user',
      sessionId: session.id,
    });
    pending = pendingHitlRequests(current?.events ?? []);
    if (pending.length === 0) return output;

    await condition(() => pending.every((r) => answers.has(r.interruptId)));
    newMessage = { role: 'user', parts: pending.map((r) => answers.get(r.interruptId)!) };
  }
}
```

- `pendingHitlRequests(events)` returns ADK's `UserInputRequest`s (plain JSON, so a
  Query can return them) that still await an answer, minus credential requests. The
  returned `HitlRequest` is a union of `HitlInputRequest` and `HitlConfirmationRequest`
  discriminated on `kind`, so narrowing on `kind` picks the builder that accepts it.
- `hitlInputResponse(request, value)` answers an input request: a plain object is
  sent as-is, anything else is wrapped in ADK's `{ result: value }` envelope.
  ADK unwraps that envelope by shape (any response whose single key is `result`)
  and parses the _string_ it unwraps as JSON, unless the request declared a
  `responseSchema` that accepts strings. A string that reads as JSON is therefore
  refused rather than silently retyped — declare a string schema on the
  `RequestInput`, or pass the parsed value. Any string that parses is refused, a
  quoted one included: `'"foo"'` would reach the node as `foo`. `value` must be a
  JSON value (`null` included): `undefined` is refused because ADK reads it as no
  answer, so the node would ask again while `pendingHitlRequests` counts it as
  answered, and a function, symbol or bigint because it is not JSON. A structured
  answer (an object or array) is also checked against the request's
  `responseSchema` exactly as ADK checks it when the graph resumes, zod's
  `fromJSONSchema` over the JSON Schema recorded on the interrupt, and refused with
  ADK's own message if it does not match; a bare scalar is exempt, as it is in ADK.
  An answer the builder accepts is one ADK will accept.
- Both builders refuse an answer only by throwing a non-retryable `ApplicationFailure`
  of type `HITL_RESPONSE_FAILURE_TYPE`, never any other error, whatever they are
  handed: they check a decision or value before reading it, schema included. That is
  what makes it safe to call them on the raw argument where the answer arrives, in
  the Signal or Update handler, as above: the SDK rejects an Update only for a
  `TemporalFailure`, so validating there tells the caller no, while letting a bad
  answer through to the Workflow body would fail the Workflow Task over and over with
  the answer already accepted (ADK refuses a schema mismatch on resume with a plain
  `Error`).
- `hitlConfirmationResponse(request, { confirmed, hint?, payload? })` answers a tool
  gate. `confirmed` must be a boolean and `hint`, when present, a string; anything
  else (`null`, `'yes'`) is refused rather than guessed, since ADK approves only on
  `confirmed === true`. ADK reads approvals from the **latest** user message only,
  so answer every pending confirmation in one message, and rebuild the agent for
  the resumed turn with the same tool names — an approval naming a tool the agent
  no longer has is refused with `IntentMismatchError`.
- Gate an Activity or MCP tool with `requireConfirmation` (a flag, or a predicate
  over the arguments that must be a pure function of them): the Activity is not
  scheduled until the human approves, and a rejection returns ADK's rejection
  result to the model. The same gate applies to a `TemporalMCPToolset` used
  directly with ADK (outside a Workflow, from `connectionParams`). A gate is only
  enforced on an `LlmAgent` turn; ADK's workflow `ToolNode` does not route through
  confirmation. Declare the gate this
  way rather than calling `toolContext.requestConfirmation()` from a tool body:
  ADK 2.0.0 binds an approval only to a tool whose `checkRequireConfirmation`
  says the call needs one, and refuses a gate requested only at run time — the
  same limit applies to `SecurityPlugin`'s `CONFIRM` outcome — ending the
  Workflow with `GoogleAdkIntentMismatchError` (`confirmation_not_required`).

  ```typescript
  activityAsTool({ name: 'deploy', description: 'Deploy.', parameters, requireConfirmation: true });
  new TemporalMCPToolset({ name: 'ops', requireConfirmation: (toolName) => toolName === 'delete' });
  ```

  With `runConfig: { plainTextToolConfirmation: true }`, a plain "yes" answers
  the single most recent pending gate — the tool runs, but the gate's function
  call is never answered, so `pendingHitlRequests` keeps listing it; track it
  yourself, as for agent-raised input requests below.

- **Agent-raised input requests.** `requestInputTool` / `getUserChoiceTool` on a
  plain `LlmAgent` pause the turn, but ADK 2.0 removes the framework call and its
  function response from the model's context: a `hitlInputResponse` clears ADK's
  pending list without the model ever seeing the value. Answer those with an
  ordinary text turn instead, and track the answered id yourself (ADK's list
  clears only on a function response). Graph `RequestInput` nodes and node-tools
  receive `hitlInputResponse` values as their input.
- Each turn appends to the session and to the Workflow history. A conversation
  long enough to need `continueAsNew` has to carry the session's events into the
  next run and replay them into a fresh session: an `InMemoryRunner`'s session
  does not survive the boundary.

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
| `DynamicNodeFailError`      | `GoogleAdkDynamicNodeFailError` (or the Temporal failure the dynamic child raised, which the wrapper carries outside `cause`) |

The mapping is exported as `ADK_RUNTIME_FAILURE_TYPES`. Anything else ADK throws
— a malformed human reply, `StreamingMode.BIDI`, a reserved function _call_ in a
client message — keeps the SDK's convention; use
`WorkerOptions.workflowFailureErrorTypes` to fail the execution on more.

Cancellation is not a failure. When a cancelled Workflow cancels the model call
an agent node is waiting on, ADK absorbs the cancelled call like any model error
and reports the node as failed (`NodeReportedError`); the plugin ends the
execution CANCELLED with the model Activity's own cancellation instead. A
cancelled Activity node ends it CANCELLED the same way, inside a dynamic run too.

A failing sibling does not cancel the execution either. When a graph node fails,
ADK aborts the run and waits for the nodes still running before failing it. The
plugin turns that abort into a cancellation of the Activity each of those nodes is
waiting on, an Activity node's Activity or an agent node's model call or tool call
(`activityAsTool`, a `TemporalMCPToolset` tool), and the execution then fails with
the failed node's failure. The Activity's `cancellationType` sets how long that wait
lasts, as it does for a node `timeout`. A tool gated with `requireConfirmation` is
cancellable only once it is approved: a pending confirmation schedules nothing.

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
    weather: mockMCPToolset(
      [
        /* tool defs */
      ],
      { resources: [{ name: 'readme', contents: [{ uri: 'file:///readme.md', text: '# Hi' }] }] }
    ),
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

- ADK generates ids — event, invocation and session ids, function-call ids,
  `RequestInput` interrupt ids — with `randomUUID()`. The sandbox has no `crypto`,
  so the plugin serves ADK a `crypto` module whose values come from a **named
  workflow random stream**: replay-stable, and independent of the Workflow's own
  `Math.random()` sequence. Those ids are **not cryptographically random** inside
  a Workflow; nor is ADK's OAuth2 `state`, which is one reason credential flows
  are unsupported there.
- ADK's node retry backoff and timeouts are durable timers; the retry jitter is
  drawn from the Workflow's `Math.random()`.
- ADK resumes a paused run from the session events: completed nodes are
  fast-forwarded, a dynamic node's body re-runs.

## Not supported in Workflows

- **Credential requests** (`adk_request_credential`). `pendingHitlRequests` drops
  them: answering one would put a secret into an Update payload that is persisted
  in Workflow history, and ADK's OAuth2 `state` is predictable in a Workflow.
  Acquire credentials on the Worker — in an Activity, or in an MCP toolset factory.
- **Live / bidirectional streaming**: `Runner.runLive`, `StreamingMode.BIDI` and
  `BaseLlm.connect` (`TemporalModel.connect` throws `GoogleAdkUnsupported`; ADK
  itself rejects `StreamingMode.BIDI` in `runAsync`).
- **Node-only ADK services.** The Workflow bundle uses ADK's web surface. It type-
  checks against ADK's full typings, but these are `undefined` at run time in a
  Workflow: the MCP classes (`MCPToolset`, `MCPSessionManager` — use
  `TemporalMCPToolset`), a2a, `DatabaseSessionService`, `GcsArtifactService` /
  `FileArtifactService`, the local code executors (`UnsafeLocalCodeExecutor`,
  `AgentEngineSandboxCodeExecutor`), telemetry setup, `LocalEnvironment`, the
  agent registry. Present but non-functional there: the skills loaders and
  `ApigeeLlm` (routed to `TemporalModel` by default).
  `BuiltInCodeExecutor` does work — it only adds Gemini's code-execution tool to
  the request the model Activity carries.
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
- Cancelling a Workflow cancels its in-flight model and MCP Activities. Both pass
  the Activity's cancellation signal down to the model / MCP client, and once that
  signal has fired the resulting error is raised as a cancellation instead of
  being classified as a model or MCP failure, so the attempt ends cancelled rather
  than being retried.

## Troubleshooting

- A Workflow that resolves a model **name** ADK does not know (a third-party
  `BaseLlm` you registered on the Worker only) throws `Model … not found` inside
  the sandbox. Wrap it: `model: new TemporalModel('my-model')`, and let
  `GoogleAdkPluginOptions.modelProvider` build it on the Worker.
- `X is not a constructor` / `X is not a function` for an ADK symbol inside a
  Workflow means the symbol is one of the node-only services above: the Workflow
  bundle resolves ADK's web surface, which omits it. Use it worker-side.
- A cryptic sandbox error during a model call (`fetch is not defined`, or a
  `… is not a function` from a worker-only module such as `google-auth-library`)
  means a `BaseLlm` performed I/O inside the Workflow — for instance
  `autoRouteModels: false` with a raw Gemini string, or a custom `BaseLlm`
  instance placed directly on an agent. Route it through `TemporalModel`.

## License

MIT
