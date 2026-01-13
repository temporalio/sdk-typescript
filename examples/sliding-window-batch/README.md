# Sliding Window Batch Processing

This example demonstrates how to process a large batch of records using a sliding window of concurrent child workflows in Temporal TypeScript SDK.

## Pattern Overview

The sliding window pattern maintains a fixed number of concurrent child workflows. As each child completes, a new one is started to fill its slot. This provides:

- **Bounded concurrency**: Never exceed `slidingWindowSize` parallel workers
- **Maximum throughput**: Start new work immediately when capacity frees up
- **Unlimited scale**: Use `continueAsNew` to process any number of records
- **Fault tolerance**: Child workflows with `ABANDON` policy survive parent restarts

## Key TypeScript SDK Concepts

### 1. Signal-Based Completion Tracking

```typescript
// Define signal
export const completionSignal = defineSignal<[number]>('ReportCompletion');

// Handle in parent
setHandler(completionSignal, (recordId: number) => {
  delete currentRecords[recordId];
  progress++;
});

// Send from child using getExternalWorkflowHandle
const parentHandle = getExternalWorkflowHandle(parentWorkflowId);
await parentHandle.signal(completionSignal, recordId);
```

### 2. Condition-Based Waiting (equivalent to Go's `workflow.Await`)

```typescript
// Wait for sliding window capacity
await condition(() => Object.keys(currentRecords).length < slidingWindowSize);

// Wait for all children to complete
await condition(() => Object.keys(currentRecords).length === 0);
```

### 3. Child Workflows with ABANDON Policy

```typescript
await startChild(processRecord, {
  args: [record, parentWorkflowId],
  workflowId: `${parentId}/record-${record.id}`,
  parentClosePolicy: 'ABANDON', // Survives parent continue-as-new
});
```

### 4. Continue-As-New for Large Batches

```typescript
await continueAsNew<typeof slidingWindowBatch>({
  pageSize,
  slidingWindowSize,
  offset: offset + childrenStarted.length,
  maximumOffset,
  progress,
  currentRecords, // Carry over in-flight records
});
```

## Go vs TypeScript Differences

| Aspect | Go | TypeScript |
|--------|-----|------------|
| Signal handling | `workflow.GetSignalChannel` + manual pump goroutine | `setHandler` - automatic |
| Blocking wait | `workflow.Await(ctx, func() bool)` | `condition(() => boolean)` |
| Goroutines | `workflow.Go(ctx, func)` | Not needed - handlers are async |
| Signal draining before CAN | Manual with `ReceiveAsync` loop | Automatic |
| External workflow handle | Direct signal via channel | `getExternalWorkflowHandle()` |

### Key Simplifications in TypeScript

1. **No signal pump needed**: Go requires a goroutine to pump signals from a channel. TypeScript signal handlers are invoked automatically.

2. **No manual drain before continue-as-new**: TypeScript SDK automatically handles signal delivery before continue-as-new.

3. **Cleaner async/await**: TypeScript's async/await is more natural than Go's explicit context passing.

## Files

- `workflows.ts` - Main implementation with activity-based parent signaling
- `workflows-v2.ts` - Alternative using `getExternalWorkflowHandle` (recommended)
- `activities.ts` / `activities-v2.ts` - Activity implementations
- `worker.ts` - Worker setup
- `client.ts` - Example client with progress monitoring

## Running the Example

```bash
# Start Temporal server (if not running)
temporal server start-dev

# Install dependencies
pnpm install

# Start the worker
pnpm run start:worker

# In another terminal, run the client
pnpm run start:client
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Sliding Window Workflow                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ State: currentRecords = {1, 2, 3, 4, 5}                 │    │
│  │        progress = 45                                     │    │
│  │        offset = 50                                       │    │
│  └─────────────────────────────────────────────────────────┘    │
│                            │                                     │
│     ┌──────────────────────┼──────────────────────┐             │
│     ▼          ▼           ▼          ▼           ▼             │
│  ┌─────┐   ┌─────┐     ┌─────┐   ┌─────┐    ┌─────┐            │
│  │ C-1 │   │ C-2 │     │ C-3 │   │ C-4 │    │ C-5 │            │
│  └──┬──┘   └──┬──┘     └──┬──┘   └──┬──┘    └──┬──┘            │
│     │         │           │         │          │                │
│     └─────────┴───────────┴─────────┴──────────┘                │
│                           │                                      │
│                    ReportCompletion(id)                         │
│                           │                                      │
│                           ▼                                      │
│              ┌────────────────────────┐                         │
│              │ condition: len < 5?    │──── Start next child    │
│              └────────────────────────┘                         │
│                           │                                      │
│              continue-as-new after pageSize                     │
└─────────────────────────────────────────────────────────────────┘
```

## Best Practices

1. **Use unique child workflow IDs**: Format as `{parentId}/{recordId}` for debugging
2. **Always signal completion in finally block**: Ensures window doesn't get stuck
3. **Handle signal errors gracefully**: Parent may have continued-as-new
4. **Set appropriate timeouts**: Consider your processing time
5. **Use heartbeats in activities**: For long-running record processing
