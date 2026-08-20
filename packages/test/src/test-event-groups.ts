import { createHash, randomUUID } from 'crypto';
import Long from 'long';
import asyncRetry from 'async-retry';
import type { ExecutionContext } from 'ava';
import * as nexus from 'nexus-rpc';
import type { WorkflowStartOptions } from '@temporalio/client';
import { WorkflowFailedError } from '@temporalio/client';
import type { UntypedActivities } from '@temporalio/common';
import { defaultPayloadConverter, defineSearchAttributeKey, SearchAttributeType } from '@temporalio/common';
import type { temporal } from '@temporalio/proto';
import type { BaseHelpers } from '@temporalio/test-helpers';
import { ByteSkewerPayloadCodec, Worker } from '@temporalio/test-helpers';
import type { NexusEndpointIdentifier } from '@temporalio/testing';
import * as workflow from '@temporalio/workflow';
import { createEventGroup, proxyActivities, sleep, startChild, type EventGroupMarker } from '@temporalio/workflow';
import type { Context as IntegrationContext } from './helpers-integration';
import { MANGLING_ENCODING, MANGLING_PREFIX } from './payload-converters/string-mangling-payload-converter';
import {
  createTestWorkflowBundle,
  createTestWorkflowEnvironment,
  helpers,
  makeConfigurableEnvironmentTestFn,
} from './helpers-integration';

// IMPORTANT: Tests in this file require a dev server with Event Groups support.
// Run with e.g. `TESTS_CLI_VERSION=v1.7.4-standalone-nexus-operations`.
const test = makeSharedWorkerForEventGroupsTest();

////////////////////////////////////////////////////////////////////////////////////////////////////
// 1. Label-based Event Group IDs (`EG-ID`)
////////////////////////////////////////////////////////////////////////////////////////////////////

export async function labelDerivedIdsWorkflow(): Promise<void> {
  const a = createEventGroup('aaa');

  // Same label with SDK-derived ID => b1 and b2 are the same group
  const b1 = createEventGroup('bbb');
  const b2 = createEventGroup('bbb');

  await Promise.all([
    sleep(1, { eventGroups: [a] }), // dont reformat
    sleep(1, { eventGroups: [b1] }),
    sleep(1, { eventGroups: [b2] }),
  ]);
}

test('Label-based Event Group with Derived IDs are correctly generated', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  // Start Workflow 1 and 2, and wait for them to complete
  const [handle1, handle2] = await Promise.all([
    startWorkflow(labelDerivedIdsWorkflow),
    startWorkflow(labelDerivedIdsWorkflow),
  ]);
  await Promise.all([handle1.result(), handle2.result()]);
  const [history1, history2] = await Promise.all([handle1.fetchHistory(), handle2.fetchHistory()]);
  const [runId1, runId2] = [handle1.firstExecutionRunId, handle2.firstExecutionRunId];

  const timersW1 = eventsOfKind(capturedEventsFromHistory(history1), 'startTimer');
  t.is(timersW1.length, 3);
  const timersW2 = eventsOfKind(capturedEventsFromHistory(history2), 'startTimer');
  t.is(timersW2.length, 3);

  // EG-ID-DERV-00: Derived IDs match the specified formula
  // The formula is intentionally spelled out here rather than using the `expectedGroupId()`
  // helper (which does the same) because this is specifically the goal of this assertion.
  t.deepEqual(
    markersOf(timersW1[0]), //
    // Formula: `lowercase(hex(sha1(`${lowercase(original_execution_run_id)}${label}`)))`
    set(labelMarker(createHash('sha1').update(`${runId1.toLowerCase()}aaa`).digest('hex').toLowerCase(), 'aaa'))
  );
  t.deepEqual(markersOf(timersW1[0]), set(labelMarker(expectedGroupId(runId1, 'aaa'), 'aaa')));
  t.deepEqual(markersOf(timersW2[0]), set(labelMarker(expectedGroupId(runId2, 'aaa'), 'aaa')));

  // EG-ID-DERV-01: same label + no user-provided ID => same group
  t.deepEqual(markersOf(timersW1[1]), markersOf(timersW1[2]));

  // EG-ID-DERV-02: different labels + no user-provided ID => distinct groups
  t.notDeepEqual(markerIdsOf(timersW1[0]), markerIdsOf(timersW1[1]));

  // EG-ID-DERV-03: same labels + different workflow execs => distinct groups
  t.notDeepEqual(markerIdsOf(timersW1[0]), markerIdsOf(timersW2[0]));
});

test('Label-based Event Group with Derived IDs remain stable across reset', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);
  const { client } = t.context.env;

  // Start workflow and wait for it to complete
  const handle1 = await startWorkflow(labelDerivedIdsWorkflow);
  const handle1RunId = handle1.firstExecutionRunId;
  await handle1.result();
  const history1 = await handle1.fetchHistory();

  // Reset workflow and wait for it to complete
  const resetResponse = await client.workflowService.resetWorkflowExecution({
    namespace: client.options.namespace,
    workflowExecution: { workflowId: handle1.workflowId, runId: handle1.firstExecutionRunId },
    workflowTaskFinishEventId: Long.fromNumber(3), // eid of first WFTStarted event
    reason: 'test event group id stability across reset',
    requestId: randomUUID(),
    identity: 'typescript-sdk-test',
  });
  const handle2RunId = resetResponse.runId!;
  t.not(handle2RunId, handle1RunId);
  const handle2 = client.workflow.getHandle(handle1.workflowId, handle2RunId);
  await handle2.result();
  const history2 = await handle2.fetchHistory();

  const timersW1 = eventsOfKind(capturedEventsFromHistory(history1), 'startTimer');
  t.is(timersW1.length, 3);
  const timersW2 = eventsOfKind(capturedEventsFromHistory(history2), 'startTimer');
  t.is(timersW2.length, 3);

  // EG-ID-DERV-04: Derived IDs are stable across a workflow reset
  t.deepEqual(markersOf(timersW1[0]), markersOf(timersW2[0]));
  t.deepEqual(markersOf(timersW1[1]), markersOf(timersW2[1]));
  t.deepEqual(markersOf(timersW1[2]), markersOf(timersW2[2]));

  t.deepEqual(markersOf(timersW2[0]), set(labelMarker(expectedGroupId(handle1RunId, 'aaa'), 'aaa')));
});

export async function labelEGUserProvidedIdsWorkflow(): Promise<void> {
  const c = createEventGroup('ccc', { id: 'c-id' });

  // Different labels but same id => d1 and d2 are the same group.
  const d1 = createEventGroup('ddd1', { id: 'd-id' });
  const d2 = createEventGroup('ddd2', { id: 'd-id' });

  await Promise.all([
    sleep(1, { eventGroups: [c] }), // dont reformat
    sleep(1, { eventGroups: [d1] }),
    sleep(1, { eventGroups: [d2] }),
  ]);
}

test('Label-based Event Group with user-provided IDs are used verbatim', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(labelEGUserProvidedIdsWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const timers = eventsOfKind(capturedEventsFromHistory(history), 'startTimer');
  t.is(timers.length, 3);

  // EG-ID-PROVID-00: User-provided IDs are used verbatim (no hashing/salting)
  t.deepEqual(markersOf(timers[0]), set(labelMarker('c-id', 'ccc')));

  // EG-ID-PROVID-01: Different labels, same user-provided ID => same group
  t.deepEqual(markerIdsOf(timers[1]), markerIdsOf(timers[2]));
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// 2. Label-based Event Group Marker Label Payload (`EG-LPAYL`)
////////////////////////////////////////////////////////////////////////////////////////////////////

export async function labelPayloadWorkflow(): Promise<void> {
  const a = createEventGroup('aaa-label');
  const b = createEventGroup('bbb-label', { id: 'b-id' });

  // The activity's argument is a control: we _know_ activity arguments go through the user-provided
  // Payload Converter, so we use it to confirm that converter is correctly configured in this test.
  await proxyActivities({
    startToCloseTimeout: '10s',
    eventGroups: [a, b],
  }).withControl('control');
}

test('Event Group Labels convert to Payloads as `json/plain` JSON strings', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(labelPayloadWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const activity = singleEvent(capturedEventsFromHistory(history), 'scheduleActivity');
  const aId = expectedGroupId(handle.firstExecutionRunId, 'aaa-label');
  const bId = 'b-id';

  // EG-LPAYL-SERZ-00: Label-based Event Group Label Payload converts to a json/plain JSON string
  t.deepEqual(markerIdsOf(activity), set(labelMarkerId(aId), labelMarkerId(bId)));
  t.is(labelPayloadOf(activity, aId).encoding, 'json/plain');
  t.is(labelPayloadOf(activity, aId).data, '"aaa-label"');
  t.is(labelPayloadOf(activity, bId).encoding, 'json/plain');
  t.is(labelPayloadOf(activity, bId).data, '"bbb-label"');
});

test("Event Group Label Payloads go through the SDK's Default Payload Converter", async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  // Setup a Worker with a custom Payload Converter
  const payloadConverterPath = require.resolve('./payload-converters/string-mangling-payload-converter');
  const worker = await createWorker({
    workflowBundle: await createTestWorkflowBundle({ workflowsPath: __filename, payloadConverterPath }),
    activities: testActivities(),
    dataConverter: { payloadConverterPath },
  });

  // Start workflow and wait for it to complete
  const handle = await worker.runUntil(async () => {
    const handle = await startWorkflow(labelPayloadWorkflow);
    await handle.result();
    return handle;
  });
  const history = await handle.fetchHistory();

  // Locate the activity; confirm it carries the expected markers.
  const activity = singleEvent(capturedEventsFromHistory(history), 'scheduleActivity');
  const aId = expectedGroupId(handle.firstExecutionRunId, 'aaa-label');
  const bId = 'b-id';
  t.deepEqual(markerIdsOf(activity), set(labelMarkerId(aId), labelMarkerId(bId)));

  // Confirm the custom converter is correctly configured: the activity's argument,
  // which does go through the worker's converter, should come out mangled.
  const control = readPayload(activity.historyEvent.activityTaskScheduledEventAttributes!.input!.payloads![0]!);
  t.is(control.encoding, MANGLING_ENCODING);
  t.is(control.data, `${MANGLING_PREFIX}control`);

  // EG-LPAYL-SERZ-01: Label-based Event Group Label Payload goes through the SDK's Default Payload Converter
  t.is(labelPayloadOf(activity, aId).encoding, 'json/plain');
  t.is(labelPayloadOf(activity, aId).data, '"aaa-label"');
  t.is(labelPayloadOf(activity, bId).encoding, 'json/plain');
  t.is(labelPayloadOf(activity, bId).data, '"bbb-label"');
});

test('Event Group Label Payloads are codec-encoded, but IDs are not', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  // Setup a Worker with a custom Payload Codec
  const codec = new ByteSkewerPayloadCodec();
  const worker = await createWorker({
    activities: testActivities(),
    dataConverter: { payloadCodecs: [codec] },
  });

  // Start workflow and wait for it to complete
  const handle = await worker.runUntil(async () => {
    const handle = await startWorkflow(labelPayloadWorkflow);
    await handle.result();
    return handle;
  });
  const history = await handle.fetchHistory();

  // Locate the activity; confirm it carries the expected markers.
  const activity = singleEvent(capturedEventsFromHistory(history), 'scheduleActivity');
  const aId = expectedGroupId(handle.firstExecutionRunId, 'aaa-label');
  const bId = 'b-id';

  // EG-LPAYL-SERZ-03: Label IDs are never codec-encoded and are readable without decoding payloads
  t.deepEqual(markerIdsOf(activity), set(labelMarkerId(aId), labelMarkerId(bId)));

  // EG-LPAYL-SERZ-02: Label-based Event Group Label Payload are processed by Payload Codecs
  const decodedLabel = async (id: string) =>
    defaultPayloadConverter.fromPayload((await codec.decode([rawLabelPayloadOf(activity, id)]))[0]!) as string;
  t.not(labelPayloadOf(activity, aId).data, '"aaa-label"');
  t.not(labelPayloadOf(activity, bId).data, '"bbb-label"');
  t.is(await decodedLabel(aId), 'aaa-label');
  t.is(await decodedLabel(bId), 'bbb-label');
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// 3. Scope propagation (`EG-SCOPE`)
////////////////////////////////////////////////////////////////////////////////////////////////////

export async function scopeBaselineWorkflow(): Promise<void> {
  const a = createEventGroup('aaa');

  // Three different command kinds, to show that the scope applies to commands in general.
  // This is only a baseline check. Full per-command-kind coverage lives in `EG-CMD`.
  await a.withScope(async () => {
    await proxyActivities({ startToCloseTimeout: '10s' }).noop();
    await sleep(1);
    // Only the initiated event is asserted on, so this waits for the child to start rather than to
    // finish — `sleepWorkflow` runs for 30s and is terminated when this parent closes.
    await startChild(sleepWorkflow);
  });
}

test("Every command in an Event Group scope carries the Event Group's marker", async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(scopeBaselineWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const a = labelMarker(expectedGroupId(handle.firstExecutionRunId, 'aaa'), 'aaa');
  const events = capturedEventsFromHistory(history);

  // EG-SCOPE-00: every command issued inside the scope carries the scope's marker
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity')), set(a));
  t.deepEqual(markersOf(singleEvent(events, 'startTimer')), set(a));
  t.deepEqual(markersOf(singleEvent(events, 'startChildWorkflowExecution')), set(a));
});

export async function nestedScopesWorkflow(): Promise<void> {
  const a = createEventGroup('aaa');
  const b = createEventGroup('bbb');
  const acts = proxyActivities({ startToCloseTimeout: '10s' });

  await a.withScope(async () => {
    await acts.inA(); // [aaa]
    await b.withScope(async () => {
      await acts.inAB(); // [aaa, bbb]
    });
    await acts.backInA(); // [aaa]
  });
  await acts.outsideAll(); // []
}

test('Nesting Event Group scopes composes correctly', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(nestedScopesWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const a = labelMarker(expectedGroupId(runId, 'aaa'), 'aaa');
  const b = labelMarker(expectedGroupId(runId, 'bbb'), 'bbb');

  const events = capturedEventsFromHistory(history);
  t.is(eventsOfKind(events, 'scheduleActivity').length, 4);

  // EG-SCOPE-01: the inner scope composes over the outer one, and exiting it restores the outer
  // set exactly; the command issued outside every scope carries no marker at all.
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'inA')), set(a));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'inAB')), set(a, b));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'backInA')), set(a));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'outsideAll')), []);
});

export async function reenteredScopeWorkflow(): Promise<void> {
  const a = createEventGroup('aaa');
  const acts = proxyActivities({ startToCloseTimeout: '10s' });

  await a.withScope(async () => {
    await acts.inA(); // [aaa]
    await a.withScope(async () => {
      await acts.reenteredA(); // [aaa], once, not twice
    });
    await acts.backInA(); // still [aaa]
  });
  await acts.outsideAll(); // []
}

test('Re-entering an Event Group instance nests correctly', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(reenteredScopeWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const a = labelMarker(expectedGroupId(handle.firstExecutionRunId, 'aaa'), 'aaa');

  const events = capturedEventsFromHistory(history);
  t.is(eventsOfKind(events, 'scheduleActivity').length, 4);

  // EG-SCOPE-02: re-entering the same instance changes nothing, and in particular the command
  // issued from the inner scope carries the marker exactly once — a duplicate would make the
  // expected set below two markers long.
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'inA')), set(a));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'reenteredA')), set(a));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'backInA')), set(a));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'outsideAll')), []);
});

export async function concurrentScopesWorkflow(): Promise<void> {
  const a = createEventGroup('aaa');
  const b = createEventGroup('bbb');
  const c = createEventGroup('ccc');
  const d = createEventGroup('ddd');
  const e = createEventGroup('eee');
  const acts = proxyActivities({ startToCloseTimeout: '10s' });

  // `a` is entered from both branches at once. Activities rather than timers, because the two
  // branches interleave, so their commands can only be told apart by activity type; each name
  // spells the groups expected on that command, e.g. `inBAC` => [bbb, aaa, ccc].
  await Promise.all([
    b.withScope(async () => {
      await a.withScope(async () => {
        await c.withScope(() => acts.inBAC());
        await acts.inBA();
      });
      await acts.inB();
    }),
    d.withScope(async () => {
      await a.withScope(async () => {
        await e.withScope(() => acts.inDAE());
        await acts.inDA();
      });
      await acts.inD();
    }),
  ]);
  await acts.noop();
}

test('An Event Group instance can be scoped concurrently from two branches', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(concurrentScopesWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const a = labelMarker(expectedGroupId(runId, 'aaa'), 'aaa');
  const b = labelMarker(expectedGroupId(runId, 'bbb'), 'bbb');
  const c = labelMarker(expectedGroupId(runId, 'ccc'), 'ccc');
  const d = labelMarker(expectedGroupId(runId, 'ddd'), 'ddd');
  const e = labelMarker(expectedGroupId(runId, 'eee'), 'eee');

  const events = capturedEventsFromHistory(history);
  t.is(eventsOfKind(events, 'scheduleActivity').length, 7);

  // EG-SCOPE-03: the two branches interleave across await points on a single thread, sharing the
  // `aaa` instance; a mutable "currently active groups" stack would cross-contaminate here.
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'inBAC')), set(b, a, c));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'inBA')), set(b, a));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'inB')), set(b));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'inDAE')), set(d, a, e));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'inDA')), set(d, a));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'inD')), set(d));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'noop')), []);
});

export async function detachedTaskScopeWorkflow(): Promise<void> {
  const a = createEventGroup('aaa');
  const acts = proxyActivities({ startToCloseTimeout: '10s' });
  let detached: Promise<void> | undefined;

  await a.withScope(async () => {
    detached = (async () => {
      await acts.insideScope(); // issued inside the scope
      await acts.afterScopeReturned(); // issued once `withScope` has returned
    })();
    // deliberately not awaited here
  });

  await detached;
  await acts.outsideScope();
}

test('A task started inside a scope keeps it after the scope exits', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(detachedTaskScopeWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const a = labelMarker(expectedGroupId(handle.firstExecutionRunId, 'aaa'), 'aaa');

  const events = capturedEventsFromHistory(history);
  t.is(eventsOfKind(events, 'scheduleActivity').length, 3);

  // EG-SCOPE-04: scope membership is captured when the task is started, so the detached task keeps
  // `aaa` for the command it issues after `withScope` has already returned.
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'insideScope')), set(a));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'afterScopeReturned')), set(a));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'outsideScope')), []);
});

export async function outsiderTaskScopeWorkflow(): Promise<void> {
  const a = createEventGroup('aaa');
  const acts = proxyActivities({ startToCloseTimeout: '10s' });

  // Started before any scope is entered, and suspended until the scope below releases it.
  let release = false;
  const outsider = (async () => {
    await workflow.condition(() => release);
    await acts.fromOutsider();
  })();

  await a.withScope(async () => {
    // A control: a command issued directly in this scope does carry `aaa`,
    // which is what makes the outsider's empty marker set meaningful.
    await acts.inA();
    release = true;
    await outsider;
  });
}

test('A task created outside a scope does not inherit it when resumed inside', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(outsiderTaskScopeWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const a = labelMarker(expectedGroupId(handle.firstExecutionRunId, 'aaa'), 'aaa');

  const events = capturedEventsFromHistory(history);
  t.is(eventsOfKind(events, 'scheduleActivity').length, 2);

  // EG-SCOPE-05: scope membership follows the context the code was *started* in,
  // not the one that happened to resume it.
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'inA')), set(a));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'fromOutsider')), []);
});

export async function throwingScopeWorkflow(): Promise<void> {
  const a = createEventGroup('aaa');
  const b = createEventGroup('bbb');
  const acts = proxyActivities({ startToCloseTimeout: '10s' });

  await a.withScope(async () => {
    try {
      await b.withScope(async () => {
        await acts.inAB(); // [aaa, bbb]
        throw new Error('boom');
      });
    } catch {
      // expected
    }
    await acts.afterThrow(); // [aaa]
  });
}

test('An Event Group scope unwinds cleanly when its body throws', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(throwingScopeWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const a = labelMarker(expectedGroupId(runId, 'aaa'), 'aaa');
  const b = labelMarker(expectedGroupId(runId, 'bbb'), 'bbb');

  const events = capturedEventsFromHistory(history);
  t.is(eventsOfKind(events, 'scheduleActivity').length, 2);

  // EG-SCOPE-06: a scope left through a throw restores the outer set, just as a normal return does
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'inAB')), set(a, b));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'afterThrow')), set(a));
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// 4. Implicit Event Groups (`EG-IMPL`)
////////////////////////////////////////////////////////////////////////////////////////////////////

export async function implicitMarkersWorkflow(): Promise<void> {
  const a = createEventGroup('aaa');
  const b = createEventGroup('bbb');
  const acts = proxyActivities({ startToCloseTimeout: '10s' });

  let signalDone = false;
  let updatesDone = 0;

  await a.withScope(async () => {
    // Both handlers are registered inside `aaa`'s scope, which they must not inherit. They are
    // also still registered before the workflow's first await — `withScope` runs its callback
    // synchronously — which matters because an update that arrives while no handler exists is
    // rejected at the end of that activation rather than buffered until one appears.
    workflow.setHandler(fireUpdate, async () => {
      await acts.fromUpdate(); // [update]
      updatesDone++;
    });

    workflow.setHandler(fireSignal, async () => {
      await acts.fromSignal(); // [signal]
      await b.withScope(() => acts.fromSignalScoped()); // [signal, bbb]
      await sleep(1); // [signal]; resumes in a later workflow task
      await acts.fromSignalLater(); // [signal]
      signalDone = true;
    });

    await acts.fromMainInScope(); // [aaa]
  });

  await acts.fromMain(); // []
  await workflow.condition(() => signalDone && updatesDone === 2);
  await acts.fromMainAfterHandlers(); // []
}

test('Implicit Event Groups wrap signal and update handlers, and nothing else', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const givenUpdateId = 'fire-update-1';

  const handle = await startWorkflow(implicitMarkersWorkflow);
  await handle.signal(fireSignal);
  await handle.executeUpdate(fireUpdate, { updateId: givenUpdateId });
  await handle.executeUpdate(fireUpdate);
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const a = labelMarker(expectedGroupId(runId, 'aaa'), 'aaa');
  const b = labelMarker(expectedGroupId(runId, 'bbb'), 'bbb');
  // The implicit signal marker references a real event id; recover it from history rather than
  // hardcoding a position that any change to the workflow above would invalidate.
  const signal = eventMarker(singleSignaledEventId(history));

  const events = capturedEventsFromHistory(history);
  t.is(eventsOfKind(events, 'scheduleActivity').length, 8);

  // EG-IMPL-00: the main function gets no implicit marker, so its commands carry only what the
  // workflow attached — nothing at all outside a scope, and the scope's marker *alone* inside one,
  // which is what tells this apart from a bug leaking one of the implicit groups.
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'fromMain')), []);
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'fromMainInScope')), set(a));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'fromMainAfterHandlers')), []);

  // EG-IMPL-01, EG-IMPL-03: the signal handler's commands carry the signaled event's marker, and
  // not `aaa` — the scope the handler was *registered* in.
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'fromSignal')), set(signal));

  // EG-IMPL-04: a scope entered inside the handler composes over the implicit marker.
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'fromSignalScoped')), set(signal, b));

  // EG-IMPL-05: the handler keeps its implicit marker across await points, including the timer and
  // the command that follows it, which are produced in a later workflow task.
  t.deepEqual(markersOf(singleEvent(events, 'startTimer')), set(signal));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'fromSignalLater')), set(signal));

  // EG-IMPL-02, EG-IMPL-03: update handlers get the `inbound_update` variant, keyed by update id —
  // the UpdateAccepted event id is not known while the handler runs. Both the client-supplied id
  // and the auto-generated one are covered, and neither command carries `aaa`.
  const updateEvents = eventsOfKind(events, 'scheduleActivity', 'fromUpdate');
  t.is(updateEvents.length, 2);
  const generatedUpdateId = updateEvents
    .flatMap((e) => e.markers)
    .map((m) => m.inboundUpdateId)
    .find((id) => id !== givenUpdateId);
  t.truthy(generatedUpdateId, 'the auto-generated update id must reach the marker');
  t.deepEqual(
    updateEvents.flatMap((e) => markersOf(e)!).sort(),
    set(updateMarker(givenUpdateId), updateMarker(generatedUpdateId!))
  );
});

export async function repeatedSignalsWorkflow(): Promise<void> {
  const acts = proxyActivities({ startToCloseTimeout: '10s' });
  let handled = 0;

  // Registered synchronously, before the first await, so that signals delivered in the very first
  // workflow task are dispatched (rather than buffered) within that same task.
  workflow.setHandler(fireSignal, async () => {
    handled++;
    await acts.fromSignal();
  });

  await workflow.condition(() => handled === 3);
}

test('Signals delivered in the same workflow task keep separate markers', async (t) => {
  // Use a distinct Worker — rather than the shared worker — so that we
  // can push three signals before the first workflow task gets picked up
  const { createWorker, startWorkflow } = helpers(t);

  // No worker yet: the three signals pile up and are all delivered in the first workflow task.
  const handle = await startWorkflow(repeatedSignalsWorkflow);
  await handle.signal(fireSignal);
  await handle.signal(fireSignal);
  await handle.signal(fireSignal);

  const worker = await createWorker({ activities: testActivities() });
  await worker.runUntil(handle.result());
  const history = await handle.fetchHistory();

  // EG-IMPL-06: three activities, each carrying exactly one implicit marker, and
  // between them the three WORKFLOW_EXECUTION_SIGNALED event ids — one per dispatch.
  const signalEventIds = signaledEventIds(history);
  t.is(signalEventIds.length, 3);

  const activities = eventsOfKind(capturedEventsFromHistory(history), 'scheduleActivity', 'fromSignal');
  t.is(activities.length, 3);
  t.deepEqual(activities.flatMap((e) => markersOf(e)!).sort(), signalEventIds.map(eventMarker).sort());
});

export async function bufferedSignalWorkflow(): Promise<void> {
  const a = createEventGroup('aaa');
  const acts = proxyActivities({ startToCloseTimeout: '10s' });
  let handled = false;

  await a.withScope(async () => {
    // The first await lets the buffered signal's activation job be processed before any handler
    // is registered; `setHandler` then dispatches it synchronously, in this scope's context.
    await sleep(1); // [aaa]
    workflow.setHandler(fireSignal, async () => {
      await acts.fromSignal(); // [signal], and in particular not [signal, aaa]
      handled = true;
    });
    await workflow.condition(() => handled);
  });
}

test('A buffered signal dispatched on handler registration gets the right marker', async (t) => {
  const { taskQueue } = t.context;
  const { client } = t.context.env;

  // Signal-with-start delivers the signal in the very first workflow task, where the workflow has
  // not reached its `setHandler` yet, so the signal is guaranteed to be buffered rather than
  // dispatched on arrival — which signalling a started workflow only achieves by racing.
  const handle = await client.workflow.signalWithStart(bufferedSignalWorkflow, {
    taskQueue,
    workflowId: randomUUID(),
    signal: fireSignal,
    signalArgs: [],
  });
  await handle.result();
  const history = await handle.fetchHistory();

  const a = labelMarker(expectedGroupId(handle.signaledRunId, 'aaa'), 'aaa');
  const signal = eventMarker(singleSignaledEventId(history));

  const events = capturedEventsFromHistory(history);
  t.is(eventsOfKind(events, 'scheduleActivity').length, 1);

  // EG-IMPL-07: the handler body runs synchronously inside the registering context, so the implicit
  // scope must *replace* the ambient set rather than extend it — no `aaa`, and the buffered
  // signal's own event id rather than that of the task the registration happened in.
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'fromSignal')), set(signal));

  // The registering context was itself under `aaa` — its own timer proves it — which
  // is what makes the assertion above meaningful.
  t.deepEqual(markersOf(singleEvent(events, 'startTimer')), set(a));
});

export async function signalWithStartWorkflow(): Promise<void> {
  const acts = proxyActivities({ startToCloseTimeout: '10s' });
  let signalDone = false;

  workflow.setHandler(fireSignal, async () => {
    await acts.fromSignal(); // [signal]
    signalDone = true;
  });

  await acts.fromMain(); // []
  await workflow.condition(() => signalDone);
}

test('Signal-with-start attributes correctly', async (t) => {
  const { taskQueue } = t.context;
  const { client } = t.context.env;

  const handle = await client.workflow.signalWithStart(signalWithStartWorkflow, {
    taskQueue,
    workflowId: randomUUID(),
    signal: fireSignal,
    signalArgs: [],
  });
  await handle.result();
  const history = await handle.fetchHistory();

  const signalEventId = singleSignaledEventId(history);

  const events = capturedEventsFromHistory(history);
  t.is(eventsOfKind(events, 'scheduleActivity').length, 2);

  // EG-IMPL-08: the signal lands in the first workflow task, alongside WorkflowExecutionStarted,
  // so the handler and the main function interleave within a single activation.
  t.is(signalEventId, 2);
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'fromSignal')), set(eventMarker(signalEventId)));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'fromMain')), []);
});

export async function defaultHandlersWorkflow(): Promise<void> {
  const acts = proxyActivities({ startToCloseTimeout: '10s' });
  let signalDone = false;
  let updateDone = false;

  workflow.setDefaultSignalHandler(async () => {
    await acts.fromSignal(); // [signal]
    signalDone = true;
  });
  workflow.setDefaultUpdateHandler(async () => {
    await acts.fromUpdate(); // [update]
    updateDone = true;
  });

  await workflow.condition(() => signalDone && updateDone);
}

test('Default signal/update handlers receive the same implicit Event Group as regular handlers', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const updateId = 'default-update-1';
  const handle = await startWorkflow(defaultHandlersWorkflow);
  // Names for which no handler is registered, so that the default handlers are what run.
  await handle.signal('some-unregistered-signal');
  await handle.executeUpdate('some-unregistered-update', { updateId, args: [] });
  await handle.result();
  const history = await handle.fetchHistory();

  const events = capturedEventsFromHistory(history);
  t.is(eventsOfKind(events, 'scheduleActivity').length, 2);

  // EG-IMPL-09: same attributions as the regular handlers of EG-IMPL-01/EG-IMPL-02.
  const signal = eventMarker(singleSignaledEventId(history));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'fromSignal')), set(signal));
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'fromUpdate')), set(updateMarker(updateId)));
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// 5. Marker set semantics (`EG-DEDUP`)
////////////////////////////////////////////////////////////////////////////////////////////////////

export async function dedupWorkflow(): Promise<void> {
  // Same label, no user-provided id => one group, and so one marker
  const a1 = createEventGroup('aaa');
  const a2 = createEventGroup('aaa');

  // Two labels, one user-provided id => also one group, and so also one marker
  const b1 = createEventGroup('bbb1', { id: 'b-id' });
  const b2 = createEventGroup('bbb2', { id: 'b-id' });

  // Reference: two distinct ids, nothing to dedupe.
  await sleep(1, { eventGroups: [a1, b1] });

  // The reference's ids, statically shuffled and duplicated.
  await sleep(1, { eventGroups: [a2, b1, a1, b1, a2, a1] });

  // And again, as nested scopes of duplicate groups.
  await a1.withScope(() => a2.withScope(() => b1.withScope(() => sleep(1))));

  // Scoped and directly attached markers dedupe against each other.
  await a1.withScope(() =>
    b1.withScope(async () => {
      await sleep(1, { eventGroups: [b1] });
      await sleep(1, { eventGroups: [b1, a1] });
    })
  );

  // The same group instance, listed twice in one call.
  await sleep(1, { eventGroups: [a1, a1] });

  // Two groups sharing an id but not a label.
  await sleep(1, { eventGroups: [b1, b2] });

  // Nested scopes of duplicate groups.
  await b1.withScope(() => sleep(1, { eventGroups: [b2] }));
}

test('Markers dedupe by ID, whether scoped or directly attached', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(dedupWorkflow);
  await handle.result();

  const aId = expectedGroupId(handle.firstExecutionRunId, 'aaa');
  const events = capturedEventsFromHistory(await handle.fetchHistory());
  const timers = eventsOfKind(events, 'startTimer');
  t.is(timers.length, 8);

  const reference = set(labelMarker(aId, 'aaa'), labelMarker('b-id', 'bbb1'));
  t.deepEqual(markersOf(timers[0]), reference);

  // EG-DEDUP-00: Duplicate markers on one command collapse into a set
  t.deepEqual(markersOf(timers[1]), reference);

  // EG-DEDUP-01: Nested scopes of duplicate groups dedupe
  t.deepEqual(markersOf(timers[2]), reference);

  // EG-DEDUP-02: Scoped and directly attached markers dedupe against each other
  t.deepEqual(markersOf(timers[3]), reference);
  t.deepEqual(markersOf(timers[4]), reference);

  // EG-DEDUP-03: The same group instance listed twice in one call dedupes
  t.deepEqual(markersOf(timers[5]), set(labelMarker(aId, 'aaa')));

  // EG-DEDUP-04: Dedup keys on id alone, disregarding labels
  // Compare IDs only, as we can't predict which label will actually be emitted.
  t.deepEqual(markerIdsOf(timers[6]), set(labelMarkerId('b-id')));
  t.deepEqual(markerIdsOf(timers[7]), set(labelMarkerId('b-id')));
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// 6. Command type coverage (`EG-CMD`)
//
// One Workflow and one test per command family. A single Workflow exercising every command would be
// cheaper to write, but any command that fails outright — a search attribute key the namespace does
// not know, say — fails the Workflow Task and takes every other command's assertions down with it,
// and an SDK that has not wired a given API could not run the section at all.
//
// Each Workflow issues its command inside `scope` *and* with `direct` attached, which proves both
// halves at once: the directly attached marker reaches history, and the ambient one is merged in
// rather than replaced. The ambient half is the one that goes untested by accident, since a call
// site that drops the ambient set still passes every direct-attachment assertion.
////////////////////////////////////////////////////////////////////////////////////////////////////

async function withCoverageScopes(body: (direct: EventGroupMarker) => Promise<unknown>): Promise<void> {
  const direct = createEventGroup('direct');
  const scope = createEventGroup('scope');
  await scope.withScope(() => body(direct));
}

/**
 * Run one of the Workflows above to completion, and return its history alongside the two marker sets
 * its commands are expected to carry: `both` for a command the Workflow attached `direct` to, and
 * `ambient` for one whose API takes no options.
 */
async function runCoverageWorkflow(
  t: ExecutionContext<Context>,
  wf: workflow.Workflow,
  args: unknown[] = []
): Promise<{ events: CapturedEvent[]; both: string[]; ambient: string[] }> {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(wf, { args });
  await handle.result();

  const runId = handle.firstExecutionRunId;
  const direct = labelMarker(expectedGroupId(runId, 'direct'), 'direct');
  const scope = labelMarker(expectedGroupId(runId, 'scope'), 'scope');
  const history = await handle.fetchHistory();

  return {
    events: capturedEventsFromHistory(history),
    both: set(direct, scope),
    ambient: set(scope),
  };
}

export async function timerMarkersWorkflow(): Promise<void> {
  await withCoverageScopes((direct) => sleep('1s', { eventGroups: [direct] }));
}

test('A timer carries both directly attached and ambient markers', async (t) => {
  const { events, both } = await runCoverageWorkflow(t, timerMarkersWorkflow);

  // EG-CMD-00: Timer commands carry both directly attached and ambient markers
  t.deepEqual(markersOf(singleEvent(events, 'startTimer')), both);

  // EG-CMD-10: the completion command is issued once the scope has exited, so it carries nothing.
  t.deepEqual(markersOf(singleEvent(events, 'completeWorkflowExecution')), []);
});

export async function conditionMarkersWorkflow(): Promise<void> {
  // The condition never holds, so what resolves this call is the timer backing its timeout.
  await withCoverageScopes((direct) => workflow.condition(() => false, '1s', { eventGroups: [direct] }));
}

test('A Wait Condition With Timeout carries both directly attached and ambient markers', async (t) => {
  const { events, both } = await runCoverageWorkflow(t, conditionMarkersWorkflow);

  // EG-CMD-01: Wait Condition With Timeout carries markers to its timer
  t.deepEqual(markersOf(singleEvent(events, 'startTimer')), both);
});

export async function activityMarkersWorkflow(): Promise<void> {
  await withCoverageScopes((direct) =>
    workflow.proxyActivities({ startToCloseTimeout: '10s', eventGroups: [direct] }).noop()
  );
}

test('An activity carries both directly attached and ambient markers', async (t) => {
  const { events, both } = await runCoverageWorkflow(t, activityMarkersWorkflow);

  // EG-CMD-02: Activity commands carry both directly attached and ambient markers
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'noop')), both);
});

export async function localActivityMarkersWorkflow(): Promise<void> {
  await withCoverageScopes((direct) =>
    workflow.proxyLocalActivities({ startToCloseTimeout: '10s', eventGroups: [direct] }).noop()
  );
}

test('A local activity carries both directly attached and ambient markers', async (t) => {
  const { events, both } = await runCoverageWorkflow(t, localActivityMarkersWorkflow);

  // EG-CMD-03: the assertion is on the marker Core records when the local activity resolves, which
  // it synthesizes well after the command that carried the markers.
  t.deepEqual(markersOf(singleEvent(events, 'scheduleLocalActivity')), both);
});

export async function childWorkflowMarkersWorkflow(): Promise<void> {
  // Only the initiated event is asserted on, so this waits for the child to start rather than to
  // finish — `sleepWorkflow` runs for 30s and is terminated when this parent closes.
  await withCoverageScopes((direct) => startChild(sleepWorkflow, { eventGroups: [direct] }));
}

test('A child workflow carries both directly attached and ambient markers', async (t) => {
  const { events, both } = await runCoverageWorkflow(t, childWorkflowMarkersWorkflow);

  // EG-CMD-04: `startChild` and `executeChild` produce the same command, so this covers both.
  t.deepEqual(markersOf(singleEvent(events, 'startChildWorkflowExecution')), both);
});

export async function nexusMarkersWorkflow(nexusEndpoint: string): Promise<void> {
  const nexusClient = workflow.createNexusServiceClient({ endpoint: nexusEndpoint, service: nexusService });
  await withCoverageScopes((direct) => nexusClient.executeOperation('noopOp', undefined, { eventGroups: [direct] }));
}

test('A Nexus operation carries both directly attached and ambient markers', async (t) => {
  const { events, both } = await runCoverageWorkflow(t, nexusMarkersWorkflow, [t.context.nexusEndpointName]);

  // EG-CMD-05: Nexus operation commands carries Event Group markers
  t.deepEqual(markersOf(singleEvent(events, 'scheduleNexusOperation')), both);
});

export async function ambientOnlyMarkersWorkflow(): Promise<void> {
  await withCoverageScopes(async () => {
    // Signalling a child handle produces the same command as signalling any external workflow.
    const child = await startChild(sleepWorkflow);
    await child.signal('noopSignal');

    // Targeting a Workflow that does not exist keeps this self-contained: the server records the
    // Initiated event, which is the one carrying the markers, then fails the request.
    await workflow
      .getExternalWorkflowHandle('event-groups-no-such-workflow')
      .cancel()
      .catch(() => undefined);

    workflow.patched('test-patch');

    // The key must be one of those the test environment registers on the namespace
    // (`defaultSAKeys`), or the server rejects the command and fails the Workflow Task.
    workflow.upsertSearchAttributes([
      { key: defineSearchAttributeKey('CustomBoolField', SearchAttributeType.BOOL), value: false },
    ]);

    workflow.upsertMemo({ 'event-groups': 'memo' });
  });
}

test('APIs that take no options carry the ambient markers', async (t) => {
  const { events, ambient } = await runCoverageWorkflow(t, ambientOnlyMarkersWorkflow);

  // EG-CMD-07, EG-CMD-08, EG-CMD-09: these APIs take no options, so the ambient scope is all they
  // can carry. Core forwards markers for every command variant, so wiring them was a matter of
  // passing the merged set at the call site.
  t.deepEqual(markersOf(singleEvent(events, 'signalExternalWorkflowExecution')), ambient);
  t.deepEqual(markersOf(singleEvent(events, 'requestCancelExternalWorkflowExecution')), ambient);
  t.deepEqual(markersOf(singleEvent(events, 'recordMarker', 'core_patch')), ambient);
  t.deepEqual(markersOf(singleEvent(events, 'modifyWorkflowProperties')), ambient);

  // Two upserts, in this order: the `TemporalChangeVersion` one Core synthesizes alongside the
  // patch marker, which carries nothing because Core generates it rather than forwarding a command
  // of ours, and then the workflow's own.
  t.deepEqual(eventsOfKind(events, 'upsertWorkflowSearchAttributes').map(markersOf), [[], ambient]);
});

export async function abandonedCommandMarkersWorkflow(): Promise<void> {
  await withCoverageScopes(async (direct) => {
    // A command cancelled before the activation is flushed never reaches the server, so its markers
    // must not be serialized (or must not fail if they are).
    const abandoned = new workflow.CancellationScope({ cancellable: true });
    const abandonedTimer = abandoned.run(() => sleep('1 day', { eventGroups: [direct] }));

    abandoned.cancel();
    await abandonedTimer.catch((err) => {
      if (!workflow.isCancellation(err)) throw err;
    });
  });
}

test('A command abandoned before its activation is flushed reaches no history at all', async (t) => {
  const { events } = await runCoverageWorkflow(t, abandonedCommandMarkersWorkflow);

  // EG-CMD-13
  t.deepEqual(eventsOfKind(events, 'startTimer'), []);
});

// Being terminal, `continueAsNew` cannot follow the shape of the families above: it ends the
// execution. Continuing into `noopWorkflow` rather than into itself is what keeps the continued run
// from continuing again.
export async function continueAsNewMarkersWorkflow(): Promise<void> {
  const direct = createEventGroup('direct');
  const scope = createEventGroup('scope');

  // Built outside the scope, as a workflow would naturally do, so that the markers merged in are
  // the ones active as of the call rather than as of construction.
  const continueAsNew = workflow.makeContinueAsNewFunc<typeof noopWorkflow>({
    workflowType: 'noopWorkflow',
    eventGroups: [direct],
  });

  await scope.withScope(() => continueAsNew());
}

test('continueAsNew carries both directly attached and ambient markers', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);
  const { client } = t.context.env;

  const handle = await startWorkflow(continueAsNewMarkersWorkflow);
  await handle.result();

  // The ContinuedAsNew event belongs to the first run, which is also the run whose id the markers
  // were derived from.
  const runId = handle.firstExecutionRunId;
  const events = capturedEventsFromHistory(await client.workflow.getHandle(handle.workflowId, runId).fetchHistory());

  const direct = labelMarker(expectedGroupId(runId, 'direct'), 'direct');
  const scope = labelMarker(expectedGroupId(runId, 'scope'), 'scope');

  // EG-CMD-06
  t.deepEqual(markersOf(singleEvent(events, 'continueAsNewWorkflowExecution')), set(direct, scope));
});

export async function cancellationCleanupWorkflow(): Promise<void> {
  const acts = proxyActivities({ startToCloseTimeout: '10s' });
  try {
    await sleep('1 day');
  } finally {
    await workflow.CancellationScope.nonCancellable(() => acts.cleanup());
  }
}

test('The Core-generated cancellation command carries no markers', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(cancellationCleanupWorkflow);
  await asyncRetry(
    async () => {
      const history = await handle.fetchHistory();
      if (!history.events?.some((e) => e.timerStartedEventAttributes != null)) {
        throw new Error('the workflow has not started its timer yet');
      }
    },
    { retries: 30, minTimeout: 100, maxTimeout: 500 }
  );
  await handle.cancel();
  await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });

  // EG-CMD-10, the counterpart of the completion command asserted with the timer above, on the
  // cancellation path. The cleanup activity is asserted alongside it because the main function
  // unwinding through a `finally` in a fresh cancellation scope is the least conventional context a
  // command gets issued from.
  const events = capturedEventsFromHistory(await handle.fetchHistory());
  t.deepEqual(markersOf(singleEvent(events, 'scheduleActivity', 'cleanup')), []);
  t.deepEqual(markersOf(singleEvent(events, 'cancelWorkflowExecution')), []);
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// HELPERS
////////////////////////////////////////////////////////////////////////////////////////////////////

// Reading markers back from history

interface CapturedMarker {
  id: string;
  label?: string;
  inboundEventId?: number;
  inboundUpdateId?: string;
  labelPayload?: temporal.api.common.v1.IPayload;
}

/** A command-generated history event, with the markers the server persisted onto it. */
interface CapturedEvent {
  eventId: number;
  /** Command variant name that produced this event (see `EVENT_ATTRIBUTE_TO_KIND`). */
  kind: string;
  /** Distinguishing detail of the command: activity type, timer id, child workflow type, … */
  name?: string;
  markers: CapturedMarker[];
  /** The event this was captured from, for the few assertions that look at its attributes. */
  historyEvent: temporal.api.history.v1.IHistoryEvent;
}

// Command-generated event types we assert on. Keeping this list explicit (rather than reflecting
// over every possible variant) keeps assertion noise low, and lets a history event be mapped back
// to the command that produced it. Events not listed here (workflow task events, activity
// completions, timer fired, …) are not command-generated and never carry markers.
const EVENT_ATTRIBUTE_TO_KIND: Record<string, string> = {
  timerStartedEventAttributes: 'startTimer',
  activityTaskScheduledEventAttributes: 'scheduleActivity',
  startChildWorkflowExecutionInitiatedEventAttributes: 'startChildWorkflowExecution',
  nexusOperationScheduledEventAttributes: 'scheduleNexusOperation',
  signalExternalWorkflowExecutionInitiatedEventAttributes: 'signalExternalWorkflowExecution',
  requestCancelExternalWorkflowExecutionInitiatedEventAttributes: 'requestCancelExternalWorkflowExecution',
  upsertWorkflowSearchAttributesEventAttributes: 'upsertWorkflowSearchAttributes',
  workflowPropertiesModifiedEventAttributes: 'modifyWorkflowProperties',
  workflowExecutionContinuedAsNewEventAttributes: 'continueAsNewWorkflowExecution',
  workflowExecutionCompletedEventAttributes: 'completeWorkflowExecution',
  workflowExecutionFailedEventAttributes: 'failWorkflowExecution',
  workflowExecutionCanceledEventAttributes: 'cancelWorkflowExecution',
  markerRecordedEventAttributes: 'recordMarker',
};

// Core records a resolved local activity as a `MarkerRecorded` event carrying this marker name,
// rather than as a dedicated command event.
const LOCAL_ACTIVITY_MARKER_NAME = 'core_local_activity';

function eventKindAndName(event: temporal.api.history.v1.IHistoryEvent): { kind: string; name?: string } | undefined {
  if (event.activityTaskScheduledEventAttributes != null) {
    return {
      kind: 'scheduleActivity',
      name: event.activityTaskScheduledEventAttributes.activityType?.name ?? undefined,
    };
  }
  if (event.timerStartedEventAttributes != null) {
    return { kind: 'startTimer', name: event.timerStartedEventAttributes.timerId ?? undefined };
  }
  if (event.startChildWorkflowExecutionInitiatedEventAttributes != null) {
    return {
      kind: 'startChildWorkflowExecution',
      name: event.startChildWorkflowExecutionInitiatedEventAttributes.workflowType?.name ?? undefined,
    };
  }
  if (event.nexusOperationScheduledEventAttributes != null) {
    return {
      kind: 'scheduleNexusOperation',
      name: event.nexusOperationScheduledEventAttributes.operation ?? undefined,
    };
  }
  if (event.markerRecordedEventAttributes != null) {
    const markerName = event.markerRecordedEventAttributes.markerName ?? undefined;
    return {
      kind: markerName === LOCAL_ACTIVITY_MARKER_NAME ? 'scheduleLocalActivity' : 'recordMarker',
      name: markerName,
    };
  }
  for (const [attribute, kind] of Object.entries(EVENT_ATTRIBUTE_TO_KIND)) {
    if ((event as Record<string, unknown>)[attribute] != null) return { kind };
  }
  return undefined;
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
      out.labelPayload = m.label.label;
      // A configured payload codec leaves the label unreadable to the default converter; tests that
      // install one assert on `labelPayload` instead.
      try {
        out.label = defaultPayloadConverter.fromPayload(m.label.label) as string;
      } catch {
        // Leave `label` unset: the payload is codec-encoded.
      }
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

/**
 * Walk a workflow history in event order and collect every command-generated event along with its
 * markers. Events with no markers are kept, with an empty marker list, so that assertions can also
 * cover the absence of markers (e.g. on the workflow completion command).
 */
function capturedEventsFromHistory(history: temporal.api.history.v1.IHistory): CapturedEvent[] {
  const captured: CapturedEvent[] = [];
  for (const event of history.events ?? []) {
    const kindAndName = eventKindAndName(event);
    if (kindAndName == null) continue;
    captured.push({
      eventId: Number(event.eventId),
      ...kindAndName,
      markers: (event.eventGroupMarkers ?? []).map(toCapturedMarker),
      historyEvent: event,
    });
  }
  return captured;
}

/** Event ids of every `WorkflowExecutionSignaled` event, in history order. */
function signaledEventIds(history: temporal.api.history.v1.IHistory): number[] {
  return (history.events ?? [])
    .filter((e) => e.workflowExecutionSignaledEventAttributes != null)
    .map((e) => Number(e.eventId));
}

/** Event id of the one `WorkflowExecutionSignaled` event; throws if there isn't exactly one. */
function singleSignaledEventId(history: temporal.api.history.v1.IHistory): number {
  const ids = signaledEventIds(history);
  if (ids.length !== 1) throw new Error(`Expected exactly one signaled event, got ${ids.length}`);
  return ids[0]!;
}

// Markers are rendered as strings so that failures print readably and so that collections can be
// compared as sets, by sorting. `renderMarker` includes the label; `renderMarkerId` does not, for
// the cases where two groups share an id but not a label and the emitted label is unspecified.
function renderMarker(m: CapturedMarker): string {
  if (m.inboundEventId !== undefined) return `event:${m.inboundEventId}`;
  if (m.inboundUpdateId !== undefined) return `update:${m.inboundUpdateId}`;
  return m.label !== undefined ? `label:${m.id}:${m.label}` : `label:${m.id}`;
}

function renderMarkerId(m: CapturedMarker): string {
  if (m.inboundEventId !== undefined) return `event:${m.inboundEventId}`;
  if (m.inboundUpdateId !== undefined) return `update:${m.inboundUpdateId}`;
  return `label:${m.id}`;
}

function markersOf(event: CapturedEvent | undefined): string[] | undefined {
  if (event == null) return undefined;
  return event.markers.map(renderMarker).sort();
}

function markerIdsOf(event: CapturedEvent | undefined): string[] | undefined {
  if (event == null) return undefined;
  return event.markers.map(renderMarkerId).sort();
}

/** A Payload read as plain text — i.e. what a consumer sees before running any Payload Codec. */
function readPayload(payload: temporal.api.common.v1.IPayload): { encoding: string; data: string } {
  return {
    encoding: Buffer.from(payload.metadata?.encoding ?? []).toString(),
    data: Buffer.from(payload.data ?? []).toString(),
  };
}

function rawLabelPayloadOf(event: CapturedEvent, id: string): temporal.api.common.v1.IPayload {
  const payload = event.markers.find((m) => m.id === id)?.labelPayload;
  if (payload == null) {
    throw new Error(
      `Expected a label payload on marker id ${id} (markers: ${JSON.stringify(event.markers.map((m) => m.id))})`
    );
  }
  return payload;
}

/** The label payload of the marker with the given id, as {@link readPayload} renders it. */
function labelPayloadOf(event: CapturedEvent, id: string): { encoding: string; data: string } {
  return readPayload(rawLabelPayloadOf(event, id));
}

/** Expected marker set, in the same normalized form as {@link markersOf}. */
function set(...markers: string[]): string[] {
  return [...markers].sort();
}

function eventMarker(eventId: number): string {
  return `event:${eventId}`;
}

function updateMarker(updateId: string): string {
  return `update:${updateId}`;
}

function labelMarker(id: string, label: string): string {
  return `label:${id}:${label}`;
}

function labelMarkerId(id: string): string {
  return `label:${id}`;
}

function eventsOfKind(events: CapturedEvent[], kind: string, name?: string): CapturedEvent[] {
  return events.filter((e) => e.kind === kind && (name === undefined || e.name === name));
}

/** The single event of the given kind (and command detail); throws if there isn't exactly one. */
function singleEvent(events: CapturedEvent[], kind: string, name?: string): CapturedEvent {
  const matches = eventsOfKind(events, kind, name);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${kind}${name === undefined ? '' : `/${name}`} event, got ${matches.length} ` +
        `(events: ${JSON.stringify(events.map((e) => ({ kind: e.kind, name: e.name })))})`
    );
  }
  return matches[0]!;
}

/**
 * Recompute the id that `createEventGroup(label)` derives when no user-provided `id` is given, per the
 * documented formula: `lowercase(hex(sha1(`${lowercase(original_execution_run_id)}${label}`)))`.
 */
function expectedGroupId(runId: string, label: string): string {
  return createHash('sha1').update(`${runId.toLowerCase()}${label}`).digest('hex').toLowerCase();
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Shared workflow building blocks
////////////////////////////////////////////////////////////////////////////////////////////////////

// The activity type name is recorded on `ActivityTaskScheduled`, which is how assertions tell
// otherwise identical commands apart. Call sites therefore make up whatever name reads best, and
// use the untyped `proxyActivities` so that they can: the Worker resolves every unregistered type
// to its `default` activity, so a name only appears here when it needs behavior of its own.
function testActivities(): UntypedActivities {
  const noop = async (): Promise<void> => undefined;
  let flakyAttempts = 0;
  return {
    default: noop,
    // Local activities get no such freedom: the Workflow sandbox checks the type name against the
    // Worker's registered names and fails the Workflow Task on a miss, so each one is named here.
    noop,
    async flaky(): Promise<void> {
      // Fails on the first attempt only; the retry must not add or duplicate markers.
      if (++flakyAttempts === 1) throw new Error('flaky activity failing on purpose');
    },
  };
}

// A workflow that does nothing at all, for cases that need a workflow type but no behavior.
export async function noopWorkflow(): Promise<void> {
  // Nothing to do.
}

// A workflow that simply sleeps for 30 seconds.
export async function sleepWorkflow(): Promise<void> {
  await sleep('30s');
}

const nexusService = nexus.service('event-groups-test-service', {
  noopOp: nexus.operation<void, void>(),
} as const);

function makeNexusServiceHandler() {
  return nexus.serviceHandler(nexusService, {
    noopOp: async (_ctx, _input): Promise<void> => undefined,
  });
}

export const fireSignal = workflow.defineSignal('fire');
export const fireUpdate = workflow.defineUpdate<void, []>('fire');

////////////////////////////////////////////////////////////////////////////////////////////////////
// The shared worker
//
// Almost every test here needs the same worker: the file's own Workflow bundle, the no-op activities
// and the Nexus service handler. Rather than build one per test, the file runs a single worker for
// its whole lifetime. Only three tests opt out, each spinning its own worker for a reason stated at
// the test: the payload codec and custom payload converter tests, whose workers must be configured
// differently, and the same-workflow-task signals test, which needs a window during which nobody is
// polling its Task Queue.
////////////////////////////////////////////////////////////////////////////////////////////////////

interface Context extends IntegrationContext {
  /** Task Queue of the shared worker, and the target of its Nexus Endpoint. */
  taskQueue: string;
  nexusEndpointName: string;
  nexusEndpoint: NexusEndpointIdentifier;
  worker: Worker;
  workerRunPromise: Promise<void>;
}

function makeSharedWorkerForEventGroupsTest() {
  return makeConfigurableEnvironmentTestFn<Context>({
    createTestContext: async () => {
      const env = await createTestWorkflowEnvironment();
      try {
        const workflowBundle = await createTestWorkflowBundle({ workflowsPath: __filename });
        // Unique per run, so that the shared worker cannot pick up executions left behind by an
        // earlier run if these tests are ever pointed at a long-lived server.
        const taskQueue = `event-groups-${randomUUID()}`;
        const nexusEndpointName = taskQueue;
        const nexusEndpoint = await env.createNexusEndpoint(nexusEndpointName, taskQueue);
        const worker = await Worker.create({
          connection: env.nativeConnection,
          namespace: env.namespace,
          workflowBundle,
          taskQueue,
          showStackTraceSources: true,
          activities: testActivities(),
          nexusServices: [makeNexusServiceHandler()],
        });
        const workerRunPromise = worker.run();
        workerRunPromise.catch((err) => {
          console.error('The shared Event Groups worker failed', err);
        });
        return { env, workflowBundle, taskQueue, nexusEndpointName, nexusEndpoint, worker, workerRunPromise };
      } catch (err) {
        await env.teardown();
        throw err;
      }
    },
    teardown: async (c) => {
      c.worker?.shutdown();
      // The failure, if any, has already been reported above; rethrowing here would only mask
      // whichever test actually failed.
      await c.workerRunPromise?.catch(() => undefined);
      if (c.nexusEndpoint) {
        await c.env.deleteNexusEndpoint(c.nexusEndpoint).catch(() => undefined);
      }
      await c.env?.teardown();
    },
  });
}

/**
 * The subset of {@link helpers} that starts Workflows, bound to the shared worker's Task Queue.
 * `helpers(t)` cannot be used for this: it derives a Task Queue from the test's title, which is
 * exactly what having one worker for the whole file does away with.
 */
function sharedWorkerHelpers(
  t: ExecutionContext<Context>
): Pick<BaseHelpers, 'taskQueue' | 'startWorkflow' | 'executeWorkflow'> {
  const { taskQueue } = t.context;
  const { client } = t.context.env;
  type StartOptions = Omit<WorkflowStartOptions, 'taskQueue' | 'workflowId'> &
    Partial<Pick<WorkflowStartOptions, 'workflowId'>>;

  return {
    taskQueue,
    async startWorkflow(fn: workflow.Workflow, opts?: StartOptions): Promise<any> {
      return await client.workflow.start(fn, { taskQueue, workflowId: randomUUID(), ...opts });
    },
    async executeWorkflow(fn: workflow.Workflow, opts?: StartOptions): Promise<any> {
      return await client.workflow.execute(fn, { taskQueue, workflowId: randomUUID(), ...opts });
    },
  };
}
