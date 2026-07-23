/**
 * Regression test for a `patched()` non-determinism error under the "A-B-A" sticky-cache pattern.
 *
 * When a worker runs a `patched()` call *live*, Core records the patch marker but never sends that
 * worker a `notifyHasPatch` job, so its lang-side `knownPresentPatches` set stays empty. If the
 * worker then keeps the run in its sticky cache while *other* workers advance the workflow, and
 * later catches its cache up over those Workflow Tasks, it re-runs the workflow's `patched()` calls
 * in *replay* activations. `patched()` must still resolve those to the recorded value; otherwise the
 * worker schedules the wrong command and fails the WFT with a TMPRL1100 nondeterminism error.
 *
 * This was observed in production (worker 1.15.1) and reproduces on every released version through
 * at least 1.20.3. On `main` it is masked by the `patchDecisions` memoization added in #2193 — but
 * that came in with an experimental feature and is not a deliberate, guaranteed fix, hence this
 * test.
 *
 * The scenario is driven deterministically with two workers whose `PollWorkflowTaskQueue` calls are
 * individually gated by a small gRPC proxy (`./poll-gate-proxy`), letting us route specific Workflow
 * Tasks to specific workers without evicting either worker's cache:
 *   1. Worker A runs the first patched iteration (records the marker) and caches the run.
 *   2. Worker B runs the next iterations (A is held; its cache goes stale).
 *   3. Worker A comes back for the finishing WFT and catches its stale cache up over B's iterations.
 */
import { randomUUID } from 'crypto';
import { temporal } from '@temporalio/proto';
import type { Worker } from '@temporalio/worker';
import { NativeConnection } from '@temporalio/worker';
import * as wf from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';
import { assertEventually, sleep } from './helpers';
import { startPollGateProxy, type PollGateProxy } from './poll-gate-proxy';

const EventType = temporal.api.enums.v1.EventType;
const NDE_CAUSE = temporal.api.enums.v1.WorkflowTaskFailedCause.WORKFLOW_TASK_FAILED_CAUSE_NON_DETERMINISTIC_ERROR;
type IHistoryEvent = temporal.api.history.v1.IHistoryEvent;

/** Per-step timeout for the deterministic A-B-A pacing waits. */
const STEP_TIMEOUT_MS = 15_000;

const test = makeTestFunction({
  workflowsPath: __filename,
});

////////////////////////////////////////////////////////////////////////////////
// Test fixtures: workflow and activities
////////////////////////////////////////////////////////////////////////////////

const activities = {
  async patchedActivity(): Promise<string> {
    return 'patched';
  },
  async noPatchActivity(): Promise<string> {
    return 'no-patch';
  },
};

const PATCH_ID = 'single-activity-registration';

const { patchedActivity, noPatchActivity } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: '30s',
  retry: { maximumAttempts: 1 },
});

const stepSignal = wf.defineSignal('step');
const finishSignal = wf.defineSignal('finish');

/**
 * Runs one `patched()`-gated activity per `step` signal, then returns on `finish`. The crucial
 * property is that `patched()` is (re-)evaluated on *every* iteration: that is what surfaces the bug
 * when a worker catches its sticky cache up over Workflow Tasks it did not originally execute — the
 * caught-up iterations run in replay activations and `patched()` must still resolve to the value the
 * recorded marker implies.
 */
export async function patchStickyCacheWorkflow(): Promise<string> {
  let steps = 0;
  let processed = 0;
  let finish = false;
  wf.setHandler(stepSignal, () => {
    steps++;
  });
  wf.setHandler(finishSignal, () => {
    finish = true;
  });

  let last = 'none';
  while (!finish) {
    // Block on the next authorized step; also forms a clean WFT boundary between iterations and
    // lets the test set up worker routing while the workflow is idle.
    await wf.condition(() => finish || steps > processed);
    if (finish) break;
    processed++;
    last = wf.patched(PATCH_ID) ? await patchedActivity() : await noPatchActivity();
  }
  return last;
}

test.serial('patched() stays active when a stale sticky cache replays other workers’ tasks', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
  const client = t.context.env.client;
  const [upHost, upPort] = t.context.env.address.replace(/^https?:\/\//, '').split(':');
  const workflowId = `patch-sticky-cache-${randomUUID()}`;

  let proxyA: PollGateProxy | undefined;
  let proxyB: PollGateProxy | undefined;
  let workerA: Worker | undefined;
  let workerB: Worker | undefined;
  let runA: Promise<void> | undefined;
  let runB: Promise<void> | undefined;
  let connA: NativeConnection | undefined;
  let connB: NativeConnection | undefined;

  const fetchEvents = async (): Promise<IHistoryEvent[]> => (await handle.fetchHistory()).events ?? [];
  const resetSticky = () =>
    client.workflowService.resetStickyTaskQueue({
      namespace: client.options.namespace,
      execution: { workflowId },
    });

  const handle = await client.workflow.start(patchStickyCacheWorkflow, { taskQueue, workflowId });

  try {
    proxyA = await startPollGateProxy(upHost, Number(upPort || '7233'));
    proxyB = await startPollGateProxy(upHost, Number(upPort || '7233'));

    // Separate connections so both workers can register on the same task queue within one process
    // (Core's in-process registration guard keys per client).
    connA = await NativeConnection.connect({ address: `127.0.0.1:${proxyA.port}` });
    connB = await NativeConnection.connect({ address: `127.0.0.1:${proxyB.port}` });
    const mkWorker = (connection: NativeConnection, identity: string) =>
      createWorker({
        connection,
        identity,
        activities,
        maxCachedWorkflows: 100,
        stickyQueueScheduleToStartTimeout: '2s',
      });
    workerA = await mkWorker(connA, 'worker-A');
    runA = workerA.run();
    workerB = await mkWorker(connB, 'worker-B');
    runB = workerB.run();

    // Phase 1: A handles the initial WFT and the first patched iteration (records the marker, caches).
    proxyA.setOpen(true);
    await assertEventually(
      t,
      async (tt) => {
        tt.true(
          count(await fetchEvents(), EventType.EVENT_TYPE_WORKFLOW_TASK_COMPLETED) >= 1,
          'A handled initial WFT'
        );
      },
      STEP_TIMEOUT_MS
    );
    await handle.signal(stepSignal);
    await assertEventually(
      t,
      async (tt) => {
        tt.true(
          count(await fetchEvents(), EventType.EVENT_TYPE_ACTIVITY_TASK_COMPLETED) >= 1,
          'A completed patched iteration 1'
        );
      },
      STEP_TIMEOUT_MS
    );
    await sleep(500);
    proxyA.setOpen(false); // A keeps its cache but receives no further WFTs

    // Phase 2: B handles the next two iterations while A's cache goes stale.
    await resetSticky();
    proxyB.setOpen(true);
    await handle.signal(stepSignal);
    await handle.signal(stepSignal);
    await assertEventually(
      t,
      async (tt) => {
        tt.true(
          count(await fetchEvents(), EventType.EVENT_TYPE_ACTIVITY_TASK_COMPLETED) >= 3,
          'B completed iterations 2-3'
        );
      },
      STEP_TIMEOUT_MS
    );
    await sleep(500);
    proxyB.setOpen(false);

    // Phase 3: A comes back for the finishing WFT and catches its stale cache up over B's iterations.
    await resetSticky();
    proxyA.setOpen(true);
    await handle.signal(finishSignal);

    // Wait for the comeback WFT to be processed, then assert the regression guarantees in one shot.
    // The A-B-A routing preconditions ensure the test can't pass vacuously; the NDE check is the
    // actual guard.
    await assertEventually(
      t,
      async (tt) => {
        const events = await fetchEvents();
        const identities = wftIdentities(events);

        // The comeback WFT has been processed (a terminal outcome or a WFT failure is present).
        tt.true(
          count(events, EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED) > 0 ||
          count(events, EventType.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED) > 0 ||
          count(events, EventType.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED) > 0,
          'comeback WFT processed'
        );

        // Preconditions: the A-B-A routing actually happened, so the test cannot pass vacuously.
        tt.is(count(events, EventType.EVENT_TYPE_MARKER_RECORDED), 1, 'exactly one patch marker recorded');
        tt.is(identities[0], 'worker-A', 'Worker A handled the initial WFT');
        tt.true(identities.includes('worker-B'), 'Worker B handled intermediate WFT(s)');
        tt.true(
          identities.lastIndexOf('worker-A') > identities.indexOf('worker-B'),
          'Worker A came back after Worker B (the A-B-A comeback)'
        );

        // The actual regression guard: A's catch-up must not raise a nondeterminism error.
        const nde = events.find(
          (e) =>
            e.eventType === EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED &&
            e.workflowTaskFailedEventAttributes?.cause === NDE_CAUSE
        );
        tt.falsy(
          nde,
          `Worker A's comeback raised a nondeterminism error: ${nde?.workflowTaskFailedEventAttributes?.failure?.message}`
        );
      },
      STEP_TIMEOUT_MS
    );

    t.log(`WFT-completed identities: ${JSON.stringify(wftIdentities(await fetchEvents()))}`);

    // And the workflow resolves the patch as active throughout.
    t.is(await handle.result(), 'patched');
  } finally {
    workerA?.shutdown();
    workerB?.shutdown();
    await Promise.allSettled([runA, runB].filter(Boolean) as Promise<void>[]);
    await Promise.allSettled([connA?.close(), connB?.close()].filter(Boolean) as Promise<void>[]);
    await Promise.allSettled([proxyA?.close(), proxyB?.close()].filter(Boolean) as Promise<void>[]);
  }
});

////////////////////////////////////////////////////////////////////////////////
// Helpers
////////////////////////////////////////////////////////////////////////////////

function count(events: IHistoryEvent[], type: temporal.api.enums.v1.EventType) {
  return events.filter((e) => e.eventType === type).length;
}

function wftIdentities(events: IHistoryEvent[]) {
  return events
    .filter((e) => e.eventType === EventType.EVENT_TYPE_WORKFLOW_TASK_COMPLETED)
    .map((e) => e.workflowTaskCompletedEventAttributes?.identity);
}
