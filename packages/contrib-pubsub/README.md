# Temporal Workflow Pub/Sub

Workflows sometimes need to push incremental updates to external observers.
Examples include providing customer updates during order processing, creating
interactive experiences with AI agents, or reporting progress from a
long-running data pipeline. Temporal's core primitives (workflows, signals, and
updates) already provide the building blocks, but wiring up batching, offset
tracking, topic filtering, and continue-as-new hand-off is non-trivial.

This module packages that boilerplate into a reusable handle and client. The
workflow acts as a message broker that maintains an append-only log.
Applications can interact directly from the workflow, or from external clients
such as activities, starters, and other workflows. Under the hood, publishing
uses signals (fire-and-forget) while subscribing uses updates (long-poll). A
configurable batching coalesces high-frequency events, improving efficiency.

Payloads are Temporal `Payload`s carrying the encoding metadata needed for
typed decode and cross-language interop. The codec chain (encryption,
PII-redaction, compression) runs once on the signal/update envelope that
carries each batch — **not** per item — so there is no double-encryption, and
codec behavior is symmetric between workflow-side and client-side publishing.

## Quick Start

### Workflow side

Construct `new PubSub()` at the start of your workflow function and use the
returned object to publish:

```typescript
import { PubSub } from '@temporalio/contrib-pubsub';

export async function myWorkflow(input: MyInput): Promise<void> {
  const pubsub = new PubSub();

  pubsub.publish('status', { state: 'started' });
  await doWork();
  pubsub.publish('status', { state: 'done' });
}
```

The `PubSub` constructor registers the `__pubsub_publish` signal,
`__pubsub_poll` update, and `__pubsub_offset` query handlers on your workflow.
Any value the default payload converter can serialize (JSON, `Uint8Array`, or
a pre-built `Payload`) can be passed to `publish`.

### Activity side (publishing)

Use `PubSubClient.fromActivity()` with `await using` for batched publishing
from inside an activity. The client and workflow ID are pulled from the
activity context:

```typescript
import { Context } from '@temporalio/activity';
import { PubSubClient } from '@temporalio/contrib-pubsub';

export async function streamEvents(): Promise<void> {
  await using client = PubSubClient.fromActivity({ batchInterval: 2.0 });
  client.start();

  for await (const chunk of generateChunks()) {
    client.publish('events', chunk);
    Context.current().heartbeat();
  }
  // Buffer is flushed automatically on scope exit.
}
```

Outside an activity (e.g., a starter or BFF), use `PubSubClient.create()`
with an explicit client and workflow id. If `await using` is not available,
call `start()` and `await stop()` explicitly:

```typescript
const client = PubSubClient.create(temporalClient, workflowId);
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

Use `PubSubClient.create()` and iterate `subscribe()`:

```typescript
import { defaultPayloadConverter } from '@temporalio/common';
import { PubSubClient } from '@temporalio/contrib-pubsub';

const client = PubSubClient.create(temporalClient, workflowId);
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

Topics allow subscribers to receive a subset of the messages in the pub/sub
system. Subscribers can request a list of specific topics, or provide an empty
list (or omit the argument) to receive messages from all topics. Publishing to
a topic implicitly creates it.

## Continue-as-new

Carry both your application state and pub/sub state across continue-as-new
boundaries:

```typescript
import { continueAsNew, workflowInfo } from '@temporalio/workflow';
import { PubSub, type PubSubState } from '@temporalio/contrib-pubsub';

interface WorkflowInput {
  itemsProcessed: number;
  pubsubState?: PubSubState;
}

export async function myWorkflow(input: WorkflowInput): Promise<void> {
  let itemsProcessed = input.itemsProcessed;
  const pubsub = new PubSub(input.pubsubState);

  // ... do work, updating itemsProcessed ...

  if (workflowInfo().continueAsNewSuggested) {
    pubsub.drain();
    // Wait for in-flight handlers to finish, then continue-as-new.
    await continueAsNew<typeof myWorkflow>({
      itemsProcessed,
      pubsubState: pubsub.getState(),
    });
  }
}
```

`drain()` unblocks waiting subscribers and rejects new polls. Subscribers
created via `PubSubClient.create()` automatically follow continue-as-new
chains.

## API Reference

### `new PubSub(priorState?)`

| Method | Description |
|---|---|
| `publish(topic, value)` | Append to the log from workflow code. Accepts any value the default payload converter handles, or a pre-built `Payload`. |
| `getState(publisherTtl = 900)` | Snapshot for continue-as-new. Drops publisher dedup entries older than `publisherTtl` seconds. |
| `drain()` | Unblock polls and reject new ones. |
| `truncate(upToOffset)` | Discard log entries below the given offset. |

Handlers registered automatically:

| Kind | Name | Description |
|---|---|---|
| Signal | `__pubsub_publish` | Receive external publications. |
| Update | `__pubsub_poll` | Long-poll subscription. |
| Query | `__pubsub_offset` | Current global offset. |

### `PubSubClient`

| Method | Description |
|---|---|
| `PubSubClient.create(client, workflowId, options?)` | Factory for use outside an activity (starters, BFFs). Enables CAN following in `subscribe()`; uses the `Client`'s configured payload converter. |
| `PubSubClient.fromActivity(options?)` | Factory for use from within an activity — pulls the client and parent workflow id from the activity context. |
| `new PubSubClient(handle, options?)` | From a handle (no CAN following). |
| `start()` | Start the background flusher. |
| `stop()` | Stop the flusher and flush remaining items. |
| `[Symbol.asyncDispose]()` | Supports `await using client = PubSubClient.create(...)`. |
| `publish(topic, value, forceFlush = false)` | Buffer a message. `value` may be any converter-compatible object or a pre-built `Payload`. `forceFlush` wakes the flusher to send immediately. |
| `subscribe(topics?, fromOffset = 0, { pollCooldown = 0.1 })` | Async generator yielding `PubSubItem` with `data: Payload`. Always follows CAN chains when created via `create()`. Recovers automatically from `TruncatedOffset` by restarting from the current base offset. |
| `getOffset()` | Query current global offset. |

### `PubSubClientOptions`

| Option | Default | Description |
|---|---|---|
| `batchInterval` | `2.0` | Seconds between automatic flushes. |
| `maxBatchSize` | `undefined` | Auto-flush when buffer reaches this size. |
| `maxRetryDuration` | `600` | Seconds to retry a failed flush before `FlushTimeoutError`. Must be less than the workflow's `publisherTtl` to preserve exactly-once delivery. |

## Cross-Language Protocol

Any Temporal client can interact with a pub/sub workflow using these fixed
handler names:

1. **Publish**: signal `__pubsub_publish` with `PublishInput`
2. **Subscribe**: update `__pubsub_poll` with `PollInput` -> `PollResult`
3. **Offset**: query `__pubsub_offset` -> `number`

Each `PublishEntry.data` / `_WireItem.data` is a base64-encoded
`temporal.api.common.v1.Payload` protobuf (`Payload.SerializeToString()` in
Python; equivalent `encodePayloadProto()` in this package). This keeps the
envelope JSON-serializable while preserving `Payload.metadata` for codec and
typed-decode paths. Cross-language clients can publish and subscribe by
following the same base64-of-serialized-`Payload` shape. The envelope types
(`PublishInput`, `PollResult`, `PubSubState`) require the default (JSON) data
converter — custom converters on the envelope layer break cross-language
interop.
