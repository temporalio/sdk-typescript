import * as nexus from 'nexus-rpc';
import { defaultPayloadConverter } from '@temporalio/common';
import type { Sinks, WorkflowInterceptors } from '@temporalio/workflow';
import * as workflow from '@temporalio/workflow';
import {
  createEventGroup,
  executeChild,
  proxyActivities,
  proxyLocalActivities,
  proxySinks,
  sleep,
} from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';

// Requires a dev server with Event Groups support. Run with e.g.
// `TESTS_CLI_VERSION=v1.7.4-standalone-nexus-operations` so the internal test harness downloads a
// server build that understands the new fields.
const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// EVENT GROUPS POC TESTS
//
// These tests assert at the lang↔core boundary (independently of server-side support):
// a `WorkflowInternalsInterceptor.concludeActivation` interceptor captures the commands the
// workflow VM is about to hand back to core, extracts their `groupMarkers`, and ships the
// observed (kind, markers) tuples to the host process via a `Sink`. The host then asserts.
//
// Three things are exercised:
//   1. Explicit markers attached via the `groups: [...]` option (`directAttachmentWorkflow`).
//   2. Scope-based propagation via `marker.run(...)`           (`scopePropagationWorkflow`).
//   3. Implicit markers around workflow start, signal handlers, and update handlers, populated
//      by the SDK with the `inbound_event_id` variant         (`implicitMarkersWorkflow`).
//
// Note that since (3) lands an implicit marker on every command issued by the workflow's main
// function (`e1`, since the WORKFLOW_EXECUTION_STARTED event always has event ID 1), the
// expected `groups` arrays in (1) and (2) are prefixed with `WORKFLOW_START_MARKER`.

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

interface CapturedCommandsSinks extends Sinks {
  capture: {
    record(entry: CapturedCommand): void;
  };
}

const { capture } = proxySinks<CapturedCommandsSinks>();

// Implicit marker that the SDK auto-creates around the workflow's main function, referencing
// the `WORKFLOW_EXECUTION_STARTED` event (event ID is always 1).
const WORKFLOW_START_MARKER: CapturedMarker = { id: 'e1', inboundEventId: 1 };

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

export async function scopePropagationWorkflow(): Promise<{
  orderId: string;
  paymentId: string;
  extraId: string;
}> {
  const order = createEventGroup('order');
  const payment = createEventGroup('payment');

  const acts = proxyActivities<MyActivities>({ startToCloseTimeout: '10s' });
  const actsWithPaymentOption = proxyActivities<MyActivities>({
    startToCloseTimeout: '10s',
    eventGroups: [payment],
  });

  let extraId: string | null = null;

  await order.run(async () => {
    // Inside the `order` scope only.
    await acts.noop();
    await payment.run(async () => {
      // Inside both `order` and `payment` scopes.
      await acts.noop();
      // Explicitly attaching a marker that's also active in scope should not duplicate it.
      await actsWithPaymentOption.noop();
      // Combining scope with a fresh explicit marker.
      const extra = createEventGroup('extra');
      extraId = extra.id;
      await sleep(1, { groups: [extra] });
    });
    // Back in the `order`-only scope.
    await acts.noop();
  });
  // Outside every explicit scope, but the implicit workflow-start marker is still active.
  await acts.noop();

  return { orderId: order.id, paymentId: payment.id, extraId: extraId! };
}

export async function directAttachmentWorkflow(endpoint: string): Promise<{ paymentId: string; auditId: string }> {
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

  return { paymentId: payment.id, auditId: audit.id };
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
// type ever sprouts a `groupMarkers` field, the test will keep working without spurious matches.
const TRACKED_COMMAND_KINDS = [
  'startTimer',
  'scheduleActivity',
  'scheduleLocalActivity',
  'startChildWorkflowExecution',
  'scheduleNexusOperation',
  'continueAsNewWorkflowExecution',
] as const;

function commandKind(cmd: Record<string, unknown>): string {
  for (const kind of TRACKED_COMMAND_KINDS) {
    if (cmd[kind] != null) return kind;
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

export const interceptors = (): WorkflowInterceptors => ({
  internals: [
    {
      concludeActivation(input, next) {
        for (const cmd of input.commands) {
          if (cmd.eventGroupMarkers && cmd.eventGroupMarkers.length > 0) {
            capture.record({
              kind: commandKind(cmd as unknown as Record<string, unknown>),
              groups: cmd.eventGroupMarkers.map((m): CapturedMarker => {
                // The SDK `id` is only carried on the wire for the `label` variant. For inbound
                // variants it is derived (matching the SDK's `e<eventId>` / `u<updateId>` scheme).
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
                  return { id: `u${m.inboundUpdate.inboundUpdateId}`, inboundUpdateId: m.inboundUpdate.inboundUpdateId };
                }
                return { id: '' };
              }),
            });
          }
        }
        return next(input);
      },
    },
  ],
});

test('direct marker attachment populates groupMarkers on every supported command type', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const captured: CapturedCommand[] = [];

  const worker = await createWorker({
    activities: {
      async noop(): Promise<void> {
        // no-op
      },
    },
    nexusServices: [makeNexusServiceHandler()],
    sinks: {
      capture: {
        record: {
          fn: (_info, entry: CapturedCommand): void => {
            captured.push(entry);
          },
        },
      },
    },
  });

  const result = await worker.runUntil(async () => {
    const handle = await startWorkflow(directAttachmentWorkflow, { args: [endpointName] });
    return await handle.result();
  });

  const { paymentId, auditId } = result;
  t.truthy(paymentId && auditId, 'createGroup should yield non-empty IDs');
  t.not(paymentId, auditId, 'each createGroup() call should yield a fresh ID');

  const byKind: Partial<Record<string, CapturedCommand[]>> = {};
  for (const entry of captured) {
    (byKind[entry.kind] ??= []).push(entry);
  }

  // Every command issued from the workflow's main function carries the implicit workflow-start
  // marker (`e1`) before the explicit `groups: [...]` ones.
  t.deepEqual(byKind.scheduleActivity, [
    { kind: 'scheduleActivity', groups: [WORKFLOW_START_MARKER, { id: paymentId, label: 'payment' }] },
  ]);
  t.deepEqual(byKind.scheduleLocalActivity, [
    { kind: 'scheduleLocalActivity', groups: [WORKFLOW_START_MARKER, { id: auditId, label: 'audit' }] },
  ]);
  t.deepEqual(byKind.startChildWorkflowExecution, [
    {
      kind: 'startChildWorkflowExecution',
      groups: [
        WORKFLOW_START_MARKER,
        { id: paymentId, label: 'payment' },
        { id: auditId, label: 'audit' },
      ],
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

  const captured: CapturedCommand[] = [];

  const worker = await createWorker({
    activities: {
      async noop(): Promise<void> {
        // no-op
      },
    },
    sinks: {
      capture: {
        record: {
          fn: (_info, entry: CapturedCommand): void => {
            captured.push(entry);
          },
        },
      },
    },
  });

  const result = await worker.runUntil(async () => {
    const handle = await startWorkflow(scopePropagationWorkflow);
    return await handle.result();
  });

  const { orderId, paymentId, extraId } = result;
  t.truthy(orderId && paymentId && extraId);

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
    groups: [
      WORKFLOW_START_MARKER,
      { id: orderId, label: 'order' },
      { id: paymentId, label: 'payment' },
    ],
  });
  t.deepEqual(captured[2], {
    kind: 'scheduleActivity',
    groups: [
      WORKFLOW_START_MARKER,
      { id: orderId, label: 'order' },
      { id: paymentId, label: 'payment' },
    ],
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

  const captured: CapturedCommand[] = [];

  const worker = await createWorker({
    activities: {
      async noop(): Promise<void> {
        // no-op
      },
    },
    sinks: {
      capture: {
        record: {
          fn: (_info, entry: CapturedCommand): void => {
            captured.push(entry);
          },
        },
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

  // Signal markers reference a real event ID (`WORKFLOW_EXECUTION_SIGNALED`); recover it
  // from history. Update markers reference the workflow-unique update id directly — no
  // history lookup needed.
  const history = await handle.fetchHistory();
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
