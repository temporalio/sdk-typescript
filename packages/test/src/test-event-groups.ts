import { createHash } from 'crypto';
import * as nexus from 'nexus-rpc';
import { defaultPayloadConverter } from '@temporalio/common';
import type { temporal } from '@temporalio/proto';
import * as workflow from '@temporalio/workflow';
import { createEventGroup, executeChild, proxyActivities, proxyLocalActivities, sleep } from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';

// IMPORTANT: Tests in this file require a dev server with Event Groups support.
// Run with e.g. `TESTS_CLI_VERSION=v1.7.4-standalone-nexus-operations`.
const test = makeTestFunction({
  workflowsPath: __filename,
  workflowEnvironmentOpts: {
    server: {
      ui: true,
    },
  },
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// EVENT GROUPS TESTS
//
// These tests assert end-to-end against the server: after running a workflow, the host fetches the
// resulting workflow history and inspects the `eventGroupMarkers` field (see
// `temporal/api/history/v1/message.proto`) that the server persists onto each command-generated
// history event. Markers attached to a command surface verbatim on the corresponding history event,
// so the expected marker sets are the same ones the SDK attaches to the outgoing commands.
//
// Three things are exercised:
//   1. Explicit markers attached via the `groups: [...]` option (`directAttachmentWorkflow`).
//   2. Scope-based propagation via `marker.withScope(...)`      (`scopePropagationWorkflow`).
//   3. Implicit markers around workflow start, signal handlers, and update handlers, populated
//      by the SDK with the `inbound_event_id` / `inbound_update_id` variants (`implicitMarkersWorkflow`).
//
// Note that since (3) lands an implicit marker on every command issued by the workflow's main
// function (`e1`, since the WORKFLOW_EXECUTION_STARTED event always has event ID 1), the
// expected `groups` arrays in (1) and (2) are prefixed with `WORKFLOW_START_MARKER`.
//
// KNOWN FAILURE: local activities are resolved client-side and recorded as `MarkerRecorded`
// events, but core currently drops the event group markers attached to local activity commands
// (see `WFCommandVariant::AddLocalActivity` in core's `workflow_machines.rs`). The local-activity
// assertion in (1) therefore fails today; it asserts the intended behavior and should pass once
// that core bug is fixed.

interface CapturedMarker {
  id: string;
  label?: string;
  inboundEventId?: number;
  inboundUpdateId?: string;
}

interface CapturedCommand {
  kind: string;
  groups: CapturedMarker[];
}

// Implicit marker that the SDK auto-creates around the workflow's main function, referencing
// the `WORKFLOW_EXECUTION_STARTED` event (event ID is always 1).
const WORKFLOW_START_MARKER: CapturedMarker = { id: 'e1', inboundEventId: 1 };

// Recompute the deterministic id that `createEventGroup(label)` derives for an explicit marker
// when no explicit `id` is provided: sha1 of the workflow's original run id concatenated with the
// label. This mirrors the SDK's derivation (see `createEventGroup`), letting the host assert on
// marker ids without the workflow having to expose them.
function expectedGroupId(runId: string, label: string): string {
  return createHash('sha1').update(`${runId}${label}`).digest('hex');
}

interface MyActivities {
  noop(): Promise<void>;
}

const nexusService = nexus.service('event-groups-test-service', {
  noopOp: nexus.operation<void, void>(),
} as const);

function makeNexusServiceHandler() {
  return nexus.serviceHandler(nexusService, {
    noopOp: async (_ctx, _input): Promise<void> => undefined,
  });
}

export async function noopChildWorkflow(): Promise<void> {
  // Intentionally empty; just produces start/complete events in the parent's history.
}

export async function scopePropagationWorkflow(): Promise<void> {
  const order = createEventGroup('order');
  const payment = createEventGroup('payment');

  const acts = proxyActivities<MyActivities>({ startToCloseTimeout: '10s' });
  const actsWithPaymentOption = proxyActivities<MyActivities>({
    startToCloseTimeout: '10s',
    eventGroups: [payment],
  });

  await order.withScope(async () => {
    // Inside the `order` scope only.
    await acts.noop();
    await payment.withScope(async () => {
      // Inside both `order` and `payment` scopes.
      await acts.noop();
      // Explicitly attaching a marker that's also active in scope should not duplicate it.
      await actsWithPaymentOption.noop();
      // Combining scope with a fresh explicit marker.
      const extra = createEventGroup('extra');
      await sleep(1, { groups: [extra] });
    });
    // Back in the `order`-only scope.
    await acts.noop();
  });
  // Outside every explicit scope, but the implicit workflow-start marker is still active.
  await acts.noop();
}

export async function directAttachmentWorkflow(endpoint: string): Promise<void> {
  const payment = createEventGroup('payment');
  const audit = createEventGroup('audit');

  const activities = proxyActivities<MyActivities>({
    startToCloseTimeout: '10s',
    eventGroups: [payment],
  });
  const localActivities = proxyLocalActivities<MyActivities>({
    startToCloseTimeout: '10s',
    eventGroups: [audit],
  });

  await activities.noop();
  await localActivities.noop();
  await executeChild(noopChildWorkflow, { groups: [payment, audit] });
  await sleep(1, { groups: [audit] });

  const nexusClient = workflow.createNexusServiceClient({ endpoint, service: nexusService });
  await nexusClient.executeOperation('noopOp', undefined, { groups: [payment] });
}

// Workflow used to exercise implicit markers around signal and update handlers. The signal
// handler and update handler each schedule one activity (so a command is observed under each
// implicit marker), then set a flag; the main function schedules one activity (observed under
// the workflow-start implicit marker) and then waits for both flags.
export const fireSignal = workflow.defineSignal('fire');
export const fireUpdate = workflow.defineUpdate<void, []>('fire');

export async function implicitMarkersWorkflow(): Promise<void> {
  const acts = proxyActivities<MyActivities>({ startToCloseTimeout: '10s' });

  let signalDone = false;
  let updateDone = false;

  workflow.setHandler(fireSignal, async () => {
    await acts.noop();
    signalDone = true;
  });

  workflow.setHandler(fireUpdate, async () => {
    await acts.noop();
    updateDone = true;
  });

  await acts.noop();
  await workflow.condition(() => signalDone && updateDone);
}

// Set of command-variant fields we care about for this test. Keeping this list explicit (rather
// than reflecting over every possible variant) keeps the assertion noise low: if a new command
// type ever sprouts an `eventGroupMarkers` field, the test will keep working without spurious
// matches. The `kind` strings are kept identical to the command-variant names used elsewhere, so a
// history event maps back to the command that produced it.
const EVENT_ATTRIBUTE_TO_KIND: Record<string, string> = {
  timerStartedEventAttributes: 'startTimer',
  activityTaskScheduledEventAttributes: 'scheduleActivity',
  startChildWorkflowExecutionInitiatedEventAttributes: 'startChildWorkflowExecution',
  nexusOperationScheduledEventAttributes: 'scheduleNexusOperation',
  workflowExecutionContinuedAsNewEventAttributes: 'continueAsNewWorkflowExecution',
};

// Core records a resolved local activity as a `MarkerRecorded` event carrying this marker name,
// rather than as a dedicated command event.
const LOCAL_ACTIVITY_MARKER_NAME = 'core_local_activity';

function eventKind(event: temporal.api.history.v1.IHistoryEvent): string {
  if (event.markerRecordedEventAttributes?.markerName === LOCAL_ACTIVITY_MARKER_NAME) {
    return 'scheduleLocalActivity';
  }
  for (const [attribute, kind] of Object.entries(EVENT_ATTRIBUTE_TO_KIND)) {
    if ((event as Record<string, unknown>)[attribute] != null) return kind;
  }
  return 'other';
}

function inboundEventIdToNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return v;
  // protobufjs returns int64 fields as Long instances when --force-long is set.
  if (typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber();
  }
  return undefined;
}

// Normalize a single persisted `EventGroupMarker` (as read back from history) into the flat shape
// the assertions compare against.
function toCapturedMarker(m: temporal.api.sdk.v1.IEventGroupMarker): CapturedMarker {
  // The SDK `id` is only carried on the wire for the `label` variant. For inbound variants it is
  // derived (matching the SDK's `e<eventId>` / `u<updateId>` scheme).
  if (m.label != null) {
    const out: CapturedMarker = { id: m.label.id ?? '' };
    if (m.label.label) {
      out.label = defaultPayloadConverter.fromPayload(m.label.label) as string;
    }
    return out;
  }
  if (m.inboundEvent != null) {
    const inboundEventId = inboundEventIdToNumber(m.inboundEvent.inboundEventId);
    const out: CapturedMarker = { id: inboundEventId !== undefined ? `e${inboundEventId}` : '' };
    if (inboundEventId !== undefined) {
      out.inboundEventId = inboundEventId;
    }
    return out;
  }
  if (m.inboundUpdate?.inboundUpdateId) {
    return {
      id: `u${m.inboundUpdate.inboundUpdateId}`,
      inboundUpdateId: m.inboundUpdate.inboundUpdateId,
    };
  }
  return { id: '' };
}

// Walk a workflow history (in event order) and collect, for every event that carries event group
// markers, the (kind, markers) tuple. Events without markers are skipped.
function capturedCommandsFromHistory(history: temporal.api.history.v1.IHistory): CapturedCommand[] {
  const captured: CapturedCommand[] = [];
  for (const event of history.events ?? []) {
    if (!event.eventGroupMarkers || event.eventGroupMarkers.length === 0) continue;
    captured.push({ kind: eventKind(event), groups: event.eventGroupMarkers.map(toCapturedMarker) });
  }
  return captured;
}

test('direct marker attachment populates groupMarkers on every supported command type', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    activities: {
      async noop(): Promise<void> {
        // no-op
      },
    },
    nexusServices: [makeNexusServiceHandler()],
  });

  const handle = await worker.runUntil(async () => {
    const handle = await startWorkflow(directAttachmentWorkflow, { args: [endpointName] });
    await handle.result();
    return handle;
  });

  // The workflow no longer exposes the derived marker ids, so recompute them here from the
  // known labels and the workflow's run id (see `expectedGroupId` / `createEventGroup`).
  const runId = handle.firstExecutionRunId;
  const paymentId = expectedGroupId(runId, 'payment');
  const auditId = expectedGroupId(runId, 'audit');
  t.truthy(paymentId && auditId, 'createEventGroup should yield non-empty IDs');
  t.not(paymentId, auditId, 'each createEventGroup() call should yield a fresh ID');

  // Read the markers back from the persisted history rather than intercepting outgoing commands.
  const history = await handle.fetchHistory();
  const captured = capturedCommandsFromHistory(history);

  const byKind: Partial<Record<string, CapturedCommand[]>> = {};
  for (const entry of captured) {
    (byKind[entry.kind] ??= []).push(entry);
  }

  // Every command issued from the workflow's main function carries the implicit workflow-start
  // marker (`e1`) before the explicit `groups: [...]` ones.
  t.deepEqual(byKind.scheduleActivity, [
    { kind: 'scheduleActivity', groups: [WORKFLOW_START_MARKER, { id: paymentId, label: 'payment' }] },
  ]);
  // The local activity is recorded as a client-side `MarkerRecorded` event; its markers should
  // surface on that event just like any other command.
  //
  // NOTE: this assertion currently fails because core drops the event group markers attached to
  // local activity commands (see `WFCommandVariant::AddLocalActivity` in `workflow_machines.rs`,
  // which never forwards `cmd.event_group_markers`). That is a bug to be fixed in core; the test
  // asserts the intended behavior.
  t.deepEqual(byKind.scheduleLocalActivity, [
    { kind: 'scheduleLocalActivity', groups: [WORKFLOW_START_MARKER, { id: auditId, label: 'audit' }] },
  ]);
  t.deepEqual(byKind.startChildWorkflowExecution, [
    {
      kind: 'startChildWorkflowExecution',
      groups: [WORKFLOW_START_MARKER, { id: paymentId, label: 'payment' }, { id: auditId, label: 'audit' }],
    },
  ]);
  t.deepEqual(byKind.startTimer, [
    { kind: 'startTimer', groups: [WORKFLOW_START_MARKER, { id: auditId, label: 'audit' }] },
  ]);
  t.deepEqual(byKind.scheduleNexusOperation, [
    { kind: 'scheduleNexusOperation', groups: [WORKFLOW_START_MARKER, { id: paymentId, label: 'payment' }] },
  ]);

  // The 'other' bucket would catch anything unexpected (e.g. a complete-workflow command that
  // somehow ended up with group markers).
  t.is(byKind.other, undefined);

  // We don't currently exercise continue-as-new from this workflow body (no host-side observation
  // of a CAN run from this same handle without further plumbing), but the option-type addition
  // is still verified by virtue of this file compiling.
  t.is(byKind.continueAsNewWorkflowExecution, undefined);
});

test('marker.run(...) propagates active markers, merges with explicit ones, and dedupes by id', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    activities: {
      async noop(): Promise<void> {
        // no-op
      },
    },
  });

  const handle = await worker.runUntil(async () => {
    const handle = await startWorkflow(scopePropagationWorkflow);
    await handle.result();
    return handle;
  });

  // Recompute the derived marker ids from the known labels and the workflow's run id, rather
  // than reading them back from the workflow (see `expectedGroupId` / `createEventGroup`).
  const runId = handle.firstExecutionRunId;
  const orderId = expectedGroupId(runId, 'order');
  const paymentId = expectedGroupId(runId, 'payment');
  const extraId = expectedGroupId(runId, 'extra');
  t.truthy(orderId && paymentId && extraId);

  // Read the markers back from the persisted history, in event order.
  const captured = capturedCommandsFromHistory(await handle.fetchHistory());

  // The workflow issues 6 commands in this order, each one ending up tagged with the implicit
  // workflow-start marker (`e1`) plus whatever scope/explicit markers are active:
  //   1. activity inside `order`               → [e1, order]
  //   2. activity inside `order` + `payment`   → [e1, order, payment]
  //   3. activity inside `order` + `payment`, explicit `[payment]` (dedup) → [e1, order, payment]
  //   4. timer  inside `order` + `payment`, explicit `[extra]`             → [e1, order, payment, extra]
  //   5. activity inside `order` only (after exiting `payment`)            → [e1, order]
  //   6. activity outside every explicit scope (only the implicit marker)  → [e1]
  t.is(captured.length, 6);

  t.deepEqual(captured[0], {
    kind: 'scheduleActivity',
    groups: [WORKFLOW_START_MARKER, { id: orderId, label: 'order' }],
  });
  t.deepEqual(captured[1], {
    kind: 'scheduleActivity',
    groups: [WORKFLOW_START_MARKER, { id: orderId, label: 'order' }, { id: paymentId, label: 'payment' }],
  });
  t.deepEqual(captured[2], {
    kind: 'scheduleActivity',
    groups: [WORKFLOW_START_MARKER, { id: orderId, label: 'order' }, { id: paymentId, label: 'payment' }],
  });
  t.deepEqual(captured[3], {
    kind: 'startTimer',
    groups: [
      WORKFLOW_START_MARKER,
      { id: orderId, label: 'order' },
      { id: paymentId, label: 'payment' },
      { id: extraId, label: 'extra' },
    ],
  });
  t.deepEqual(captured[4], {
    kind: 'scheduleActivity',
    groups: [WORKFLOW_START_MARKER, { id: orderId, label: 'order' }],
  });
  t.deepEqual(captured[5], {
    kind: 'scheduleActivity',
    groups: [WORKFLOW_START_MARKER],
  });
});

test('implicit markers wrap workflow start, signal handlers, and update handlers', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    activities: {
      async noop(): Promise<void> {
        // no-op
      },
    },
  });

  // Pick a known update id so the assertion can match without scraping it back from history.
  const explicitUpdateId = 'fire-update-1';

  const handle = await worker.runUntil(async () => {
    const handle = await startWorkflow(implicitMarkersWorkflow);
    // Send the signal and the update; each handler schedules one activity and then sets a
    // flag, which together let the workflow's `condition` resolve and the workflow complete.
    await handle.signal(fireSignal);
    await handle.executeUpdate(fireUpdate, { updateId: explicitUpdateId });
    await handle.result();
    return handle;
  });

  const history = await handle.fetchHistory();
  const captured = capturedCommandsFromHistory(history);

  // Signal markers reference a real event ID (`WORKFLOW_EXECUTION_SIGNALED`); recover it
  // from history. Update markers reference the workflow-unique update id directly — no
  // history lookup needed.
  const signalEvent = history.events!.find((e) => e.workflowExecutionSignaledEventAttributes)!;
  const signalEventId = Number(signalEvent.eventId);
  t.true(signalEventId > 1, 'signal event ID should be greater than the WF-start event ID');

  // Three scheduleActivity commands are recorded — one from each of: main body, signal
  // handler, update handler. The captured order isn't guaranteed (depends on activation
  // batching), so check by grouping.
  t.is(captured.length, 3, 'one scheduleActivity per dispatch site');
  for (const entry of captured) {
    t.is(entry.kind, 'scheduleActivity');
    t.is(entry.groups.length, 1, 'no explicit markers, just the implicit one');
  }

  // Split captured markers into buckets by variant for easier assertions.
  const eventIdMarkers = new Map(
    captured
      .map((entry) => entry.groups[0])
      .filter((m) => m.inboundEventId !== undefined)
      .map((m) => [m.inboundEventId!, m])
  );
  const updateIdMarkers = new Map(
    captured
      .map((entry) => entry.groups[0])
      .filter((m) => m.inboundUpdateId !== undefined)
      .map((m) => [m.inboundUpdateId!, m])
  );

  t.deepEqual(eventIdMarkers.get(1), WORKFLOW_START_MARKER);
  t.deepEqual(eventIdMarkers.get(signalEventId), { id: `e${signalEventId}`, inboundEventId: signalEventId });
  t.deepEqual(updateIdMarkers.get(explicitUpdateId), {
    id: `u${explicitUpdateId}`,
    inboundUpdateId: explicitUpdateId,
  });
});
