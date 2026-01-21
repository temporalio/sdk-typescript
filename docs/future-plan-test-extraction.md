# Future Plan: Moving Integration Tests Near the Code They Test

## Goal

Establish a pattern for packages to contain their own integration tests, enabling:

- Independent testing of packages without running the full test suite
- Clear ownership of tests alongside the code they test
- Preparation for future package splits (e.g., OTel v2)

## Current State

All integration tests live in `packages/test/`. This works but has drawbacks:

- Must run full test suite to verify changes to a specific package
- Test ownership is unclear
- Difficult to test packages with conflicting dependencies

## Key Challenges

### 1. The Bundling Problem

Tests that use `workflowsPath: __filename` bundle the test file itself as a workflow. When bundled:

- Modules in `ignoreModules` resolve to empty objects
- Re-exports from ignored modules become `undefined`
- Top-level code that calls helper functions fails

**This is why we couldn't simply create a shared `@temporalio/test-helpers` package with re-exports.**

### 2. Shared Test Fixtures

The test package contains shared fixtures:

- `history_files/` - replay test histories
- `workflows/` - test workflow implementations
- `activities/` - test activity implementations

Some fixtures are used across many tests; others are package-specific.

### 3. Dependency Direction

Packages like `interceptors-opentelemetry` have peer dependencies:

```
interceptors-opentelemetry
  └── @temporalio/workflow (peer)
  └── @temporalio/common (peer)
```

For testing, we add devDependencies (fine since they're not shipped):

```
interceptors-opentelemetry (devDependencies)
  └── @temporalio/worker
  └── @temporalio/testing
  └── @temporalio/client
```

## Recommended Approach: Self-Contained Test Fixtures (Option D)

Each package contains its own test workflows, activities, and history files in `src/__tests__/`.

### Directory Structure

```
packages/interceptors-opentelemetry/
├── src/
│   ├── __tests__/
│   │   ├── test-otel.ts                       # Main test file
│   │   ├── workflows/
│   │   │   ├── index.ts                       # Export all workflows
│   │   │   ├── definitions.ts                 # Signal/query definitions
│   │   │   ├── smorgasbord.ts                 # Complex integration workflow
│   │   │   ├── signal-target.ts               # Simple signal workflow
│   │   │   ├── success-string.ts              # Trivial workflow
│   │   │   ├── throw-maybe-benign.ts          # Benign error testing
│   │   │   ├── update-start-otel.ts           # Update with start testing
│   │   │   └── otel-interceptors.ts           # Interceptor registration
│   │   ├── activities/
│   │   │   ├── index.ts                       # Export all activities
│   │   │   ├── echo.ts                        # Simple echo activity
│   │   │   ├── fake-progress.ts               # Heartbeat/progress activity
│   │   │   ├── query-own-wf.ts                # Query scheduling workflow
│   │   │   └── throw-maybe-benign.ts          # Benign error activity
│   │   └── history_files/                     # Replay test histories
│   │       ├── otel_1_11_3.json
│   │       ├── otel_1_13_1.json
│   │       └── otel_smorgasbord_1_13_1.json
│   ├── client/
│   ├── worker/
│   └── workflow/
└── package.json
```

### Required Test Fixtures for OTel Package

| File                               | Lines    | Complexity | Notes                    |
| ---------------------------------- | -------- | ---------- | ------------------------ |
| `definitions.ts`                   | ~10      | Trivial    | Signal/query definitions |
| `success-string.ts`                | ~3       | Trivial    | Returns "success"        |
| `signal-target.ts`                 | ~25      | Simple     | Waits for signal         |
| `throw-maybe-benign.ts` (workflow) | ~12      | Simple     | Calls activity           |
| `update-start-otel.ts`             | ~12      | Simple     | Update handler           |
| `smorgasbord.ts`                   | ~75      | Complex    | Full integration test    |
| `echo.ts`                          | ~7       | Trivial    | Returns input            |
| `fake-progress.ts`                 | ~18      | Simple     | Heartbeat loop           |
| `query-own-wf.ts`                  | ~10      | Simple     | Queries parent workflow  |
| `throw-maybe-benign.ts` (activity) | ~8       | Simple     | Returns based on attempt |
| `otel-interceptors.ts`             | ~10      | Simple     | Registers interceptors   |
| **Total**                          | **~190** |            |                          |

### Code Examples

**`src/__tests__/workflows/definitions.ts`:**

```typescript
import { defineQuery, defineSignal } from '@temporalio/workflow';

export const activityStartedSignal = defineSignal('activityStarted');
export const unblockSignal = defineSignal('unblock');
export const stepQuery = defineQuery<number>('step');
```

**`src/__tests__/workflows/success-string.ts`:**

```typescript
export async function successString(): Promise<string> {
  return 'success';
}
```

**`src/__tests__/workflows/signal-target.ts`:**

```typescript
import { condition, setHandler } from '@temporalio/workflow';
import { unblockSignal } from './definitions';

export async function signalTarget(): Promise<void> {
  let unblocked = false;
  setHandler(unblockSignal, () => void (unblocked = true));
  await condition(() => unblocked);
}
```

**`src/__tests__/workflows/smorgasbord.ts`:**

```typescript
import {
  sleep,
  startChild,
  proxyActivities,
  proxyLocalActivities,
  ActivityCancellationType,
  CancellationScope,
  isCancellation,
  setHandler,
  condition,
  continueAsNew,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import { signalTarget } from './signal-target';
import { activityStartedSignal, unblockSignal, stepQuery } from './definitions';

const { fakeProgress, queryOwnWf } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1m',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

const { echo } = proxyLocalActivities<typeof activities>({
  startToCloseTimeout: '1m',
});

export async function smorgasbord(iteration = 0): Promise<void> {
  let unblocked = false;
  setHandler(stepQuery, () => iteration);
  setHandler(activityStartedSignal, () => void (unblocked = true));

  try {
    await CancellationScope.cancellable(async () => {
      const activityPromise = fakeProgress(100, 10);
      const queryActPromise = queryOwnWf(stepQuery);
      const timerPromise = sleep(1000);
      const childWfPromise = (async () => {
        const childWf = await startChild(signalTarget, {});
        await childWf.signal(unblockSignal);
        await childWf.result();
      })();
      const localActivityPromise = echo('local-activity');

      if (iteration === 0) CancellationScope.current().cancel();

      await Promise.all([
        activityPromise,
        queryActPromise,
        timerPromise,
        childWfPromise,
        localActivityPromise,
        condition(() => unblocked),
      ]);
    });
  } catch (e) {
    if (iteration !== 0 || !isCancellation(e)) throw e;
  }
  if (iteration < 2) await continueAsNew<typeof smorgasbord>(iteration + 1);
}
```

**`src/__tests__/activities/index.ts`:**

```typescript
export { echo } from './echo';
export { fakeProgress } from './fake-progress';
export { queryOwnWf, signalSchedulingWorkflow } from './query-own-wf';
export { throwMaybeBenign } from './throw-maybe-benign';
```

**`src/__tests__/activities/fake-progress.ts`:**

```typescript
import { Context } from '@temporalio/activity';
import { CancelledFailure } from '@temporalio/common';
import { signalSchedulingWorkflow } from './query-own-wf';

export async function fakeProgress(sleepIntervalMs = 1000, numIters = 100): Promise<void> {
  await signalSchedulingWorkflow('activityStarted');
  try {
    for (let progress = 1; progress <= numIters; ++progress) {
      await Context.current().sleep(sleepIntervalMs);
      Context.current().heartbeat(progress);
    }
  } catch (err) {
    if (!(err instanceof CancelledFailure)) throw err;
    throw err;
  }
}
```

**`src/__tests__/activities/query-own-wf.ts`:**

```typescript
import { Context } from '@temporalio/activity';
import { QueryDefinition } from '@temporalio/common';

function getSchedulingWorkflowHandle() {
  const { info, client } = Context.current();
  return client.workflow.getHandle(info.workflowExecution.workflowId, info.workflowExecution.runId);
}

export async function signalSchedulingWorkflow(signalName: string): Promise<void> {
  await getSchedulingWorkflowHandle().signal(signalName);
}

export async function queryOwnWf<R, A extends any[]>(queryDef: QueryDefinition<R, A>, ...args: A): Promise<R> {
  return await getSchedulingWorkflowHandle().query(queryDef, ...args);
}
```

**`src/__tests__/test-otel.ts` (simplified excerpt):**

```typescript
import test from 'ava';
import * as path from 'path';
import * as fs from 'fs/promises';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, Runtime, bundleWorkflowCode, DefaultLogger } from '@temporalio/worker';
import { WorkflowClient } from '@temporalio/client';
import * as activities from './activities';
import * as workflows from './workflows';
import { makeWorkflowExporter, OpenTelemetryActivityInboundInterceptor } from '../worker';

// Helper to load history files from __tests__/history_files/
async function loadHistory(fname: string) {
  const filePath = path.join(__dirname, 'history_files', fname);
  const contents = await fs.readFile(filePath, 'utf8');
  return JSON.parse(contents);
}

// Helper to bundle test workflows
async function createTestBundle() {
  return await bundleWorkflowCode({
    workflowsPath: require.resolve('./workflows'),
    ignoreModules: ['@temporalio/activity', '@temporalio/client', '@temporalio/testing', '@temporalio/worker', 'ava'],
    logger: new DefaultLogger('WARN'),
  });
}

test('Otel interceptor spans are connected', async (t) => {
  const env = await TestWorkflowEnvironment.createLocal();
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      workflowsPath: require.resolve('./workflows'),
      activities,
      taskQueue: 'test-otel',
      interceptors: {
        workflowModules: [require.resolve('./workflows/otel-interceptors')],
        activity: [(ctx) => ({ inbound: new OpenTelemetryActivityInboundInterceptor(ctx) })],
      },
    });
    // ... test implementation
  } finally {
    await env.teardown();
  }
});

test('Can replay otel history', async (t) => {
  const hist = await loadHistory('otel_1_11_3.json');
  await t.notThrowsAsync(async () => {
    await Worker.runReplayHistory({ workflowBundle: await createTestBundle() }, hist);
  });
});
```

### Package Configuration

**`package.json` additions:**

```json
{
  "devDependencies": {
    "@temporalio/client": "workspace:*",
    "@temporalio/testing": "workspace:*",
    "@temporalio/worker": "workspace:*",
    "ava": "^5.3.1"
  },
  "scripts": {
    "test": "ava ./lib/__tests__/test-*.js"
  },
  "ava": {
    "timeout": "120s",
    "serial": true
  },
  "files": ["lib", "src", "!src/__tests__", "!lib/__tests__"]
}
```

**`tsconfig.json` additions:**

```json
{
  "include": ["./src/**/*.ts"],
  "exclude": ["./src/__tests__/history_files"]
}
```

### Pros

- Complete test isolation - package is self-contained
- Clear ownership - tests live with the code they test
- Independent CI - can test package separately
- Enables future package splits without test restructuring
- History files versioned with the package

### Cons

- ~190 lines of workflow/activity code per package that needs integration tests
- History files may need to be copied
- Changes to common test patterns require updating multiple packages

### When to Use This Pattern

Use self-contained test fixtures when:

- Package has unique dependencies (like specific OTel versions)
- Package needs independent CI/testing
- Tests are specific to the package's functionality
- Preparing for potential package splits

Keep tests in `packages/test/` when:

- Tests require multiple packages working together
- Tests use fixtures shared across many packages
- The overhead of duplication isn't justified

## Implementation Checklist

### For interceptors-opentelemetry

- [ ] Create `src/__tests__/` directory structure
- [ ] Create `src/__tests__/workflows/` with:
  - [ ] `definitions.ts` (signals/queries)
  - [ ] `index.ts` (exports)
  - [ ] `success-string.ts`
  - [ ] `signal-target.ts`
  - [ ] `smorgasbord.ts`
  - [ ] `throw-maybe-benign.ts`
  - [ ] `update-start-otel.ts`
  - [ ] `otel-interceptors.ts`
- [ ] Create `src/__tests__/activities/` with:
  - [ ] `index.ts` (exports)
  - [ ] `echo.ts`
  - [ ] `fake-progress.ts`
  - [ ] `query-own-wf.ts`
  - [ ] `throw-maybe-benign.ts`
- [ ] Copy history files to `src/__tests__/history_files/`
- [ ] Create `test-otel.ts` with helpers (`loadHistory`, `createTestBundle`)
- [ ] Update `package.json` with devDependencies and test scripts
- [ ] Update `tsconfig.json` to exclude history files
- [ ] Verify: `pnpm -F @temporalio/interceptors-opentelemetry test`

### Cleanup

- [ ] Remove OTel-specific tests from `packages/test/src/test-otel.ts`
- [ ] Update CI to run package tests

## Notes on History Files

History files (`otel_1_11_3.json`, etc.) are used for replay tests.

- Copy relevant history files to the package's `src/__tests__/history_files/`
- Exclude from npm publish via `files` array in package.json
- History files can be regenerated if needed for future versions

## Alternative Approaches Considered

### Option A: Keep All Tests in test Package

Keep `test-otel.ts` in the test package.

**Pros:** No refactoring needed, shared fixtures remain centralized
**Cons:** Can't test package in isolation, must run full test suite

### Option B: Split by Test Type

Unit tests in package, integration tests in test package.

**Pros:** Fast unit tests run in package
**Cons:** Tests split across packages, still need test package for integration

### Option C: Shared Test Fixtures Package

Create `@temporalio/test-fixtures` package with shared workflows/activities.

**Pros:** Shared fixtures without duplication
**Cons:** Another package to maintain, bundling complexity with `ignoreModules`

Option D (self-contained fixtures) was chosen because it provides complete isolation with acceptable duplication (~190 lines), and prepares us for future package splits.
