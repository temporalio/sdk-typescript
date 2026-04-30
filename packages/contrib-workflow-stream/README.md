# Temporal Workflow Streams

**Workflow Streams** — a Temporal SDK contrib library that gives a workflow a
durable, offset-addressed event channel built from Signals and polling Updates
with an SSE bridge. Cost scales with durable batches, not tokens. Latency is
around 100ms per roundtrip; not for ultra-low-latency voice.

Workflows sometimes need to push incremental updates to external observers.
Examples include providing customer updates during order processing, creating
interactive experiences with AI agents, or reporting progress from a
long-running data pipeline. Temporal's core primitives (workflows, signals, and
updates) already provide the building blocks, but wiring up batching, offset
tracking, topic filtering, and continue-as-new hand-off is non-trivial.

This module packages that boilerplate into a reusable workflow-side stream
object and external client. The workflow holds an append-only log of
`(topic, data)` entries. Applications can interact directly from the workflow,
or from external clients such as activities, starters, and other workflows.
Under the hood, publishing uses signals (fire-and-forget) while subscribing
uses updates (long-poll). A configurable batching coalesces high-frequency
events, improving efficiency.

Payloads are Temporal `Payload`s carrying the encoding metadata needed for
typed decode and cross-language interop. The codec chain (encryption,
PII-redaction, compression) runs once on the signal/update envelope that
carries each batch — **not** per item — so there is no double-encryption, and
codec behavior is symmetric between workflow-side and client-side publishing.

## Quick Start

### Workflow side

Construct `new WorkflowStream()` at the start of your workflow function and use the
returned object to publish:

```typescript
import { WorkflowStream } from '@temporalio/contrib-workflow-stream';

export async function myWorkflow(input: MyInput): Promise<void> {
  const stream = new WorkflowStream();

  stream.publish('status', { state: 'started' });
  await doWork();
  stream.publish('status', { state: 'done' });
}
```

The `WorkflowStream` constructor registers the `__temporal_workflow_stream_publish` signal,
`__temporal_workflow_stream_poll` update, and `__temporal_workflow_stream_offset` query handlers on your workflow.
Any value the default payload converter can serialize (JSON, `Uint8Array`, or
a pre-built `Payload`) can be passed to `publish`.

### Activity side (publishing)

Use `WorkflowStreamClient.fromActivity()` with `await using` for batched publishing
from inside an activity. The client and workflow ID are pulled from the
activity context:

```typescript
import { Context } from '@temporalio/activity';
import { WorkflowStreamClient } from '@temporalio/contrib-workflow-stream';

export async function streamEvents(): Promise<void> {
  await using client = WorkflowStreamClient.fromActivity({ batchInterval: '2 seconds' });
  client.start();

  for await (const chunk of generateChunks()) {
    client.publish('events', chunk);
    Context.current().heartbeat();
  }
  // Buffer is flushed automatically on scope exit.
}
```

Outside an activity (e.g., a starter or BFF), use `WorkflowStreamClient.create()`
with an explicit client and workflow id. If `await using` is not available,
call `start()` and `await stop()` explicitly:

```typescript
const client = WorkflowStreamClient.create(temporalClient, workflowId);
client.start();
try {
  client.publish('events', data);
} finally {
  await client.stop();
}
```

Use `forceFlush = true` to trigger an immediate flush for latency-sensitive
events:

```typescript
client.publish('events', data, true);
```

### Subscribing

Use `WorkflowStreamClient.create()` and iterate `subscribe()`:

```typescript
import { defaultPayloadConverter } from '@temporalio/common';
import { WorkflowStreamClient } from '@temporalio/contrib-workflow-stream';

const client = WorkflowStreamClient.create(temporalClient, workflowId);
for await (const item of client.subscribe(['events'], 0)) {
  // item.data is a Payload; decode with a payload converter
  const value = defaultPayloadConverter.fromPayload<MyType>(item.data);
  console.log(item.topic, item.offset, value);
  if (isDone(value)) break;
}
```

`item.data` is a `Payload` carrying encoding metadata, so any converter-known
value round-trips (`json/plain` for JSON, `binary/plain` for `Uint8Array`, etc.).

## Topics

Topics allow subscribers to receive a subset of the messages in the workflow stream
system. Subscribers can request a list of specific topics, or provide an empty
list (or omit the argument) to receive messages from all topics. Publishing to
a topic implicitly creates it.

## Continue-as-new

Carry both your application state and workflow stream state across continue-as-new
boundaries:

```typescript
import { continueAsNew, workflowInfo } from '@temporalio/workflow';
import { WorkflowStream, type WorkflowStreamState } from '@temporalio/contrib-workflow-stream';

interface WorkflowInput {
  itemsProcessed: number;
  streamState?: WorkflowStreamState;
}

export async function myWorkflow(input: WorkflowInput): Promise<void> {
  let itemsProcessed = input.itemsProcessed;
  const stream = new WorkflowStream(input.streamState);

  // ... do work, updating itemsProcessed ...

  if (workflowInfo().continueAsNewSuggested) {
    await stream.continueAsNew<typeof myWorkflow>((state) => [{
      itemsProcessed,
      streamState: state,
    }]);
  }
}
```

`WorkflowStream.continueAsNew(buildArgs)` detaches waiting pollers, waits for
in-flight handlers to finish, then calls `continueAsNew` with the args
returned by `buildArgs(state)`. The lambda receives the post-detach
`WorkflowStreamState` as its only argument so the snapshot is guaranteed
to happen *after* pollers detach. Subscribers created via
`WorkflowStreamClient.create()` automatically follow continue-as-new chains.

If you need to pass other CAN options (search attributes, memo,
non-default `taskQueue`, etc.), fall back to the explicit recipe with
`makeContinueAsNewFunc`:

```typescript
import { condition, allHandlersFinished, makeContinueAsNewFunc } from '@temporalio/workflow';

if (workflowInfo().continueAsNewSuggested) {
  stream.detachPollers();
  await condition(allHandlersFinished);
  const continueWithOptions = makeContinueAsNewFunc<typeof myWorkflow>({
    taskQueue: 'other-tq',
  });
  await continueWithOptions({
    itemsProcessed,
    streamState: stream.getState(),
  });
}
```

## API Reference

### `new WorkflowStream(priorState?)`

| Method | Description |
|---|---|
| `publish(topic, value)` | Append to the log from workflow code. Accepts any value the default payload converter handles, or a pre-built `Payload`. |
| `getState(publisherTtl?)` | Snapshot for continue-as-new. Drops publisher dedup entries older than `publisherTtl` (`Duration`, default `'15 minutes'`). |
| `detachPollers()` | Unblock polls and reject new ones. |
| `continueAsNew<F>(buildArgs, options?)` | Async. Detach pollers, wait for handlers, then `continueAsNew` with `buildArgs(state)`. Use the explicit recipe with `makeContinueAsNewFunc` to pass other CAN options. |
| `truncate(upToOffset)` | Discard log entries below the given offset. |

Handlers registered automatically:

| Kind | Name | Description |
|---|---|---|
| Signal | `__temporal_workflow_stream_publish` | Receive external publications. |
| Update | `__temporal_workflow_stream_poll` | Long-poll subscription. |
| Query | `__temporal_workflow_stream_offset` | Current global offset. |

### `WorkflowStreamClient`

| Method | Description |
|---|---|
| `WorkflowStreamClient.create(client, workflowId, options?)` | Factory for use outside an activity (starters, BFFs). Enables CAN following in `subscribe()`; uses the `Client`'s configured payload converter. |
| `WorkflowStreamClient.fromActivity(options?)` | Factory for use from within an activity — pulls the client and parent workflow id from the activity context. |
| `new WorkflowStreamClient(handle, options?)` | From a handle (no CAN following). |
| `start()` | Start the background flusher. |
| `stop()` | Stop the flusher and flush remaining items. |
| `[Symbol.asyncDispose]()` | Supports `await using client = WorkflowStreamClient.create(...)`. |
| `publish(topic, value, forceFlush = false)` | Buffer a message. `value` may be any converter-compatible object or a pre-built `Payload`. `forceFlush` wakes the flusher to send immediately. |
| `subscribe(topics?, fromOffset = 0, { pollCooldown = '100 milliseconds' })` | Async generator yielding `WorkflowStreamItem` with `data: Payload`. `pollCooldown` is a `Duration`. Always follows CAN chains when created via `create()`. Recovers automatically from `TruncatedOffset` by restarting from the current base offset. |
| `getOffset()` | Query current global offset. |

### `WorkflowStreamClientOptions`

| Option | Default | Description |
|---|---|---|
| `batchInterval` | `'2 seconds'` | Interval between automatic flushes (`Duration`). |
| `maxBatchSize` | `undefined` | Auto-flush when buffer reaches this size. |
| `maxRetryDuration` | `'10 minutes'` | Time to retry a failed flush before `FlushTimeoutError` (`Duration`). Must be less than the workflow's `publisherTtl` to preserve exactly-once delivery. |

## Cross-Language Protocol

Any Temporal client can interact with a workflow stream workflow using these fixed
handler names:

1. **Publish**: signal `__temporal_workflow_stream_publish` with `PublishInput`
2. **Subscribe**: update `__temporal_workflow_stream_poll` with `PollInput` -> `PollResult`
3. **Offset**: query `__temporal_workflow_stream_offset` -> `number`

Each `PublishEntry.data` / `_WorkflowStreamWireItem.data` is a base64-encoded
`temporal.api.common.v1.Payload` protobuf (`Payload.SerializeToString()` in
Python; equivalent `encodePayloadProto()` in this package). This keeps the
envelope JSON-serializable while preserving `Payload.metadata` for codec and
typed-decode paths. Cross-language clients can publish and subscribe by
following the same base64-of-serialized-`Payload` shape. The envelope types
(`PublishInput`, `PollResult`, `WorkflowStreamState`) require the default (JSON) data
converter — custom converters on the envelope layer break cross-language
interop.
