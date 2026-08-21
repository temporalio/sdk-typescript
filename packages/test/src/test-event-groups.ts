import { createHash, randomUUID } from 'crypto';
import Long from 'long';
import type { ExecutionContext } from 'ava';
import * as nexus from 'nexus-rpc';
import type { WorkflowStartOptions } from '@temporalio/client';
import type { UntypedActivities } from '@temporalio/common';
import { defaultPayloadConverter, defineSearchAttributeKey, SearchAttributeType } from '@temporalio/common';
import type { temporal } from '@temporalio/proto';
import type { BaseHelpers } from '@temporalio/test-helpers';
import { ByteSkewerPayloadCodec, Worker } from '@temporalio/test-helpers';
import type { NexusEndpointIdentifier } from '@temporalio/testing';
import { activityInfo, sleep as activitySleep } from '@temporalio/activity';
import * as workflow from '@temporalio/workflow';
import { CancellationScope, createEventGroup, proxyActivities, sleep, startChild } from '@temporalio/workflow';
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
// 1. Explicit Event Groups Marker Label IDs (`EG-LABEL-ID`)
////////////////////////////////////////////////////////////////////////////////////////////////////

export async function derivedLocalIdsWorkflow(): Promise<void> {
  // SDK-derived IDs
  const a = createEventGroup('aaa');

  // Same label with SDK-derived ID => b1 and b2 are the same group
  const b1 = createEventGroup('bbb');
  const b2 = createEventGroup('bbb');

  await Promise.all([
    // One activity call for each label object
    scheduleActivity('activity-a', { eventGroups: [a] }),
    scheduleActivity('activity-b1', { eventGroups: [b1] }),
    scheduleActivity('activity-b2', { eventGroups: [b2] }),
  ]);
}

test('Label-based Event Group with Derived IDs are correctly generated', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  // Start Workflow 1 and 2, and wait for them to complete
  const [handle1, handle2] = await Promise.all([
    startWorkflow(derivedLocalIdsWorkflow),
    startWorkflow(derivedLocalIdsWorkflow),
  ]);
  await Promise.all([handle1.result(), handle2.result()]);
  const [history1, history2] = await Promise.all([handle1.fetchHistory(), handle2.fetchHistory()]);
  const [runId1, _runId2] = [handle1.firstExecutionRunId, handle2.firstExecutionRunId];

  t.is(eventsOfKind(history1, 'scheduleActivity').length, 3);
  t.is(eventsOfKind(history2, 'scheduleActivity').length, 3);

  // EG-LABEL-ID-00: Derived IDs match the specified formula
  t.deepEqual(
    markerIdsOf(singleEvent(history1, 'scheduleActivity', 'activity-a')),
    set(labelMarkerId(expectedGroupId(runId1, 'aaa')))
  );

  // EG-LABEL-ID-01: Same labels + no user-provided ID + same workflow exec => same group IDs
  t.deepEqual(
    markerIdsOf(singleEvent(history1, 'scheduleActivity', 'activity-b1')),
    markerIdsOf(singleEvent(history1, 'scheduleActivity', 'activity-b2'))
  );

  // EG-LABEL-ID-02: Different labels + no user-provided ID + same workflow exec => distinct group IDs
  t.notDeepEqual(
    markerIdsOf(singleEvent(history1, 'scheduleActivity', 'activity-a')),
    markerIdsOf(singleEvent(history1, 'scheduleActivity', 'activity-b1'))
  );

  // EG-LABEL-ID-03: Same labels + no user-provided ID + different workflow execs => distinct group IDs
  t.notDeepEqual(
    markerIdsOf(singleEvent(history1, 'scheduleActivity', 'activity-a')),
    markerIdsOf(singleEvent(history2, 'scheduleActivity', 'activity-a'))
  );
});

test('Label-based Event Group with Derived IDs remain stable across reset', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);
  const { client } = t.context.env;

  // Start workflow and wait for it to complete
  const handle1 = await startWorkflow(derivedLocalIdsWorkflow);
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

  t.is(eventsOfKind(history1, 'scheduleActivity').length, 3);
  t.is(eventsOfKind(history2, 'scheduleActivity').length, 3);

  // Control: confirm that the reset resulted in the initial WFT being executed again
  t.notDeepEqual(
    history1.events?.find((e) => e.workflowTaskCompletedEventAttributes != null)?.eventTime,
    history2.events?.find((e) => e.workflowTaskCompletedEventAttributes != null)?.eventTime,
    'ResetWorkflow should have resulted in WFT being executed again'
  );

  // EG-LABEL-ID-04: Derived IDs are stable across a workflow reset
  t.deepEqual(
    markerIdsOf(singleEvent(history2, 'scheduleActivity', 'activity-a')),
    set(labelMarkerId(expectedGroupId(handle1RunId, 'aaa'))),
    'Derived ID should be calculated based on the original execution run id (i.e. pre-reset)'
  );
  t.deepEqual(
    markerIdsOf(singleEvent(history1, 'scheduleActivity', 'activity-b1')),
    markerIdsOf(singleEvent(history2, 'scheduleActivity', 'activity-b1')),
    'Derived ID should remain the same across reset'
  );
});

export async function userProvidedLocalIdsWorkflow(): Promise<void> {
  const c = createEventGroup('ccc', { id: 'c-id' });

  // Different labels but same id => d1 and d2 are the same group.
  const d1 = createEventGroup('ddd1', { id: 'd-id' });
  const d2 = createEventGroup('ddd2', { id: 'd-id' });

  await Promise.all([
    scheduleActivity('activity-c', { eventGroups: [c] }),
    scheduleActivity('activity-d1', { eventGroups: [d1] }),
    scheduleActivity('activity-d2', { eventGroups: [d2] }),
  ]);
}

test('Label-based Event Group with user-provided IDs are used verbatim', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(userProvidedLocalIdsWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  t.is(eventsOfKind(history, 'scheduleActivity').length, 3);

  // EG-LABEL-ID-20: User-provided IDs are used verbatim
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'activity-c')), set(labelMarkerId('c-id')));

  // EG-LABEL-ID-21: Different labels + same user-provided ID => same group
  t.deepEqual(
    markerIdsOf(singleEvent(history, 'scheduleActivity', 'activity-d1')),
    markerIdsOf(singleEvent(history, 'scheduleActivity', 'activity-d2'))
  );
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// 2. Explicit Event Groups Marker Label Payload (`EG-LABEL-PAYLOAD`)
////////////////////////////////////////////////////////////////////////////////////////////////////

export async function labelPayloadWorkflow(): Promise<void> {
  const a = createEventGroup('aaa-label');
  const b = createEventGroup('bbb-label', { id: 'b-id' });

  // Control: We use the activity's input argument as a control to confirm that
  // the custom payload converter is correctly configured
  await scheduleActivity('activity-a', { args: ['control'], eventGroups: [a] });
  await scheduleActivity('activity-b', { args: ['control'], eventGroups: [b] });
}

test('Event Group Labels convert to Payloads as JSON strings using Default Payload Converter', async (t) => {
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

  const activityA = singleEvent(history, 'scheduleActivity', 'activity-a');
  const activityB = singleEvent(history, 'scheduleActivity', 'activity-b');

  const aId = expectedGroupId(handle.firstExecutionRunId, 'aaa-label');
  const bId = 'b-id';

  // EG-LABEL-PAYLOAD-00: Label Payload converts to a json/plain JSON string
  t.deepEqual(markerIdsOf(activityA), set(labelMarkerId(aId)));
  t.is(labelPayloadOf(activityA, aId).encoding, 'json/plain');
  t.is(labelPayloadOf(activityA, aId).data, '"aaa-label"');
  t.is(labelPayloadOf(activityB, bId).encoding, 'json/plain');
  t.is(labelPayloadOf(activityB, bId).data, '"bbb-label"');

  // EG-LABEL-PAYLOAD-01: Label Payload goes through the SDK's Default Payload Converter
  //
  // We already confirmed above that the label was converted to a JSON string Payload,
  // which corresponds to the behavior of the Default Payload Converter, but we also need to
  // confirm that we specifically used that converter instead of the custom converter
  // (i.e. who knows, maybe the custom converter is misconfigured so this is a false positive?).
  //
  // For that reason, we use the activity's input argument as a control value and confirm
  // that it effectively gets converted by our custom Payload Converter.
  const control = readPayload(activityA.historyEvent.activityTaskScheduledEventAttributes!.input!.payloads![0]!);
  t.is(control.encoding, MANGLING_ENCODING);
  t.is(control.data, `${MANGLING_PREFIX}control`);
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

  const activityA = singleEvent(history, 'scheduleActivity', 'activity-a');
  const activityB = singleEvent(history, 'scheduleActivity', 'activity-b');

  const aId = expectedGroupId(handle.firstExecutionRunId, 'aaa-label');
  const bId = 'b-id';

  const decodedLabel = async (payload: temporal.api.common.v1.IPayload) =>
    defaultPayloadConverter.fromPayload((await codec.decode([payload]))[0]!) as string;

  // EG-LABEL-PAYLOAD-20: Label-based Event Group label payloads are processed by Payload Codecs
  t.not(labelPayloadOf(activityA, aId).data, '"aaa-label"');
  t.not(labelPayloadOf(activityB, bId).data, '"bbb-label"');
  t.is(await decodedLabel(rawLabelPayloadOf(activityA, aId)), 'aaa-label');
  t.is(await decodedLabel(rawLabelPayloadOf(activityB, bId)), 'bbb-label');

  // EG-LABEL-PAYLOAD-21: Label IDs are not codec-encoded
  t.deepEqual(markerIdsOf(activityA), set(labelMarkerId(aId)));
  t.deepEqual(markerIdsOf(activityB), set(labelMarkerId(bId)));
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// 3. Explicit Event Group Scopes (`EG-SCOPE`)
////////////////////////////////////////////////////////////////////////////////////////////////////

export async function scopeBaselineWorkflow(): Promise<void> {
  const acts = proxyActivities({ startToCloseTimeout: '10s' });

  const a = createEventGroup('aaa');

  // Three different command kinds, to show that the scope applies to commands in general.
  // This is only a baseline check. Full per-command-kind coverage lives in `EG-COMMANDS`.
  await a.withScope(async () => {
    await acts.noop();
    await sleep(1);
    await startChild(sleepWorkflow);
  });
}

test('Commands in an Event Group scope carry its marker', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(scopeBaselineWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const a = labelMarkerId(expectedGroupId(handle.firstExecutionRunId, 'aaa'));

  // EG-SCOPE-00: Commands in an Event Group scope carry its marker
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity')), set(a));
  t.deepEqual(markerIdsOf(singleEvent(history, 'startTimer')), set(a));
  t.deepEqual(markerIdsOf(singleEvent(history, 'startChildWorkflowExecution')), set(a));
});

export async function nestedScopesWorkflow(): Promise<void> {
  const acts = proxyActivities({ startToCloseTimeout: '10s' });

  const a = createEventGroup('aaa');
  const b = createEventGroup('bbb');

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
  const a = labelMarkerId(expectedGroupId(runId, 'aaa'));
  const b = labelMarkerId(expectedGroupId(runId, 'bbb'));

  t.is(eventsOfKind(history, 'scheduleActivity').length, 4);

  // EG-SCOPE-01: Nesting Event Group Scopes composes correctly
  // The inner scope composes over the outer one, and exiting it restores the outer set exactly;
  // the command issued outside every scope carries no marker at all.
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'inA')), set(a));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'inAB')), set(a, b));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'backInA')), set(a));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'outsideAll')), []);
});

export async function reenteredScopeWorkflow(): Promise<void> {
  const acts = proxyActivities({ startToCloseTimeout: '10s' });

  const a = createEventGroup('aaa');

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

  const a = labelMarkerId(expectedGroupId(handle.firstExecutionRunId, 'aaa'));

  t.is(eventsOfKind(history, 'scheduleActivity').length, 4);

  // EG-SCOPE-02: Re-entering an Event Group instance nests correctly
  // Re-entering the same instance changes nothing; the command issued from the inner scope
  // carries the marker exactly once — a duplicate would make the expected set two markers long.
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'inA')), set(a));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'reenteredA')), set(a));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'backInA')), set(a));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'outsideAll')), []);
});

export async function concurrentScopesWorkflow(): Promise<void> {
  const acts = proxyActivities({ startToCloseTimeout: '10s' });

  const a = createEventGroup('aaa');
  const b = createEventGroup('bbb');
  const c = createEventGroup('ccc');
  const d = createEventGroup('ddd');
  const e = createEventGroup('eee');

  // `a` is entered from both branches at once. Activities rather than timers, because the two
  // branches interleave, so their commands can only be told apart by activity type; each name
  // spells the groups expected on that command, e.g. `inBAC` => [bbb, aaa, ccc].
  await Promise.all([
    b.withScope(async () => {
      await a.withScope(async () => {
        await c.withScope(async () => {
          await acts.inBAC();
        });
        await acts.inBA();
      });
      await acts.inB();
    }),
    d.withScope(async () => {
      await a.withScope(async () => {
        await e.withScope(async () => {
          await acts.inDAE();
        });
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
  const a = labelMarkerId(expectedGroupId(runId, 'aaa'));
  const b = labelMarkerId(expectedGroupId(runId, 'bbb'));
  const c = labelMarkerId(expectedGroupId(runId, 'ccc'));
  const d = labelMarkerId(expectedGroupId(runId, 'ddd'));
  const e = labelMarkerId(expectedGroupId(runId, 'eee'));

  t.is(eventsOfKind(history, 'scheduleActivity').length, 7);

  // EG-SCOPE-03: An Event Group instance can be scoped concurrently from two branches
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'inBAC')), set(b, a, c));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'inBA')), set(b, a));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'inB')), set(b));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'inDAE')), set(d, a, e));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'inDA')), set(d, a));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'inD')), set(d));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'noop')), []);
});

export async function detachedTaskScopeWorkflow(): Promise<void> {
  const acts = proxyActivities({ startToCloseTimeout: '10s' });

  const a = createEventGroup('aaa');
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

  const a = labelMarkerId(expectedGroupId(handle.firstExecutionRunId, 'aaa'));

  t.is(eventsOfKind(history, 'scheduleActivity').length, 3);

  // EG-SCOPE-04: A task started inside a scope keeps it after the scope exits
  // Scope membership is captured when the task is started, so the detached task keeps `aaa` for
  // the command it issues after `withScope` has already returned.
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'insideScope')), set(a));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'afterScopeReturned')), set(a));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'outsideScope')), []);
});

export async function outsiderTaskScopeWorkflow(): Promise<void> {
  const acts = proxyActivities({ startToCloseTimeout: '10s' });

  const a = createEventGroup('aaa');

  // Started before any scope is entered, and suspended until the scope below releases it.
  let release = false;
  const outsider = (async () => {
    await workflow.condition(() => release);
    await acts.fromOutsider();
  })();

  await a.withScope(async () => {
    // Control: a command issued directly in this scope does carry `aaa`,
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

  const a = labelMarkerId(expectedGroupId(handle.firstExecutionRunId, 'aaa'));

  t.is(eventsOfKind(history, 'scheduleActivity').length, 2);

  // EG-SCOPE-05: A task created outside a scope does not inherit it when resumed inside
  // Scope membership follows the context the code was *started* in, not the one that resumed it.
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'inA')), set(a));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'fromOutsider')), []);
});

export async function throwingScopeWorkflow(): Promise<void> {
  const acts = proxyActivities({ startToCloseTimeout: '10s' });

  const a = createEventGroup('aaa');
  const b = createEventGroup('bbb');

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
  const a = labelMarkerId(expectedGroupId(runId, 'aaa'));
  const b = labelMarkerId(expectedGroupId(runId, 'bbb'));

  t.is(eventsOfKind(history, 'scheduleActivity').length, 2);

  // EG-SCOPE-06: An Event Group scope unwinds cleanly when its body throws
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'inAB')), set(a, b));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'afterThrow')), set(a));
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// 4. Implicit Event Groups (`EG-IMPLICIT`)
//
// TypeScript has no statically declared handlers, so EG-IMPLICIT-00, 01, 50, and 51 do not apply.
////////////////////////////////////////////////////////////////////////////////////////////////////

export async function runtimeRegisteredSignalWorkflow(): Promise<void> {
  const acts = proxyActivities({ startToCloseTimeout: '10s' });

  const outside = createEventGroup('outside');
  const inside = createEventGroup('inside');

  let signalDone = false;

  await outside.withScope(async () => {
    workflow.setHandler(fireSignal, async () => {
      await acts.fromSignal(); // [signal], not [signal, outside]

      await inside.withScope(async () => {
        await acts.fromSignalScoped(); // [signal, inside]
      });

      signalDone = true;
    });
    await acts.inOutside(); // [outside]
  });

  await acts.fromMainBefore(); // []
  await workflow.condition(() => signalDone);
  await acts.fromMainAfter(); // []
}

test('Implicit scope on runtime-registered signal handler exists and composes appropriately', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(runtimeRegisteredSignalWorkflow);
  await handle.signal(fireSignal);
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const outside = labelMarkerId(expectedGroupId(runId, 'outside'));
  const inside = labelMarkerId(expectedGroupId(runId, 'inside'));
  const signal = eventMarker(singleSignaledEventId(history));

  t.is(eventsOfKind(history, 'scheduleActivity').length, 5);

  // EG-IMPLICIT-10: A runtime-registered signal handler does not inherit its registration scope
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'fromSignal')), set(signal));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'inOutside')), set(outside)); // Control

  // EG-IMPLICIT-11: An explicit scope composes with a runtime-registered signal handler's implicit scope
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'fromSignalScoped')), set(signal, inside));

  // EG-IMPLICIT-30: Signal implicit scope does not leak to commands in the Workflow main function
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'fromMainBefore')), []);
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'fromMainAfter')), []);
});

export async function bufferedSignalWorkflow(): Promise<void> {
  const acts = proxyActivities({ startToCloseTimeout: '10s' });

  let unblocked = false;
  workflow.setHandler(unblockSignal, () => {
    unblocked = true;
  });
  await workflow.condition(() => unblocked);

  let handled = false;
  workflow.setHandler(fireSignal, async () => {
    await acts.fromSignal(); // [signal] for the signal that was buffered before this registration
    handled = true;
  });
  await workflow.condition(() => handled);
}

test('A signal buffered before runtime registration keeps its original implicit marker', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(bufferedSignalWorkflow);

  // `fire` is sent while only `unblock` has a handler, so it is buffered.
  // `unblock` then lets the registration proceed and dispatch the buffered signal.
  await handle.signal(fireSignal);
  await handle.signal(unblockSignal);
  await handle.result();
  const history = await handle.fetchHistory();

  // `fire` is sent first, so it is the first signaled event; `unblock` is the second.
  const signalEventIds = signaledEventIds(history);
  t.is(signalEventIds.length, 2);
  const signal = eventMarker(signalEventIds[0]!);

  t.is(eventsOfKind(history, 'scheduleActivity').length, 1);

  // EG-IMPLICIT-12: A signal buffered before runtime registration keeps its original implicit marker
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'fromSignal')), set(signal));
});

export async function runtimeRegisteredUpdateWorkflow(): Promise<void> {
  const acts = proxyActivities({ startToCloseTimeout: '10s' });

  const outside = createEventGroup('outside');
  const inside = createEventGroup('inside');

  let updateDone = false;

  await outside.withScope(async () => {
    // Same timing constraint as the signal case, and stricter: an update that arrives while
    // no handler exists is rejected at the end of that activation rather than buffered.
    workflow.setHandler(fireUpdate, async () => {
      await acts.fromUpdate(); // [update], not [update, outside]

      await inside.withScope(async () => {
        await acts.fromUpdateScoped(); // [update, inside]
      });

      updateDone = true;
    });
    await acts.inOutside(); // [outside]
  });

  await acts.fromMainBefore(); // []
  await workflow.condition(() => updateDone);
  await acts.fromMainAfter(); // []
}

test('Implicit scope on runtime-registered update handler exists and composes appropriately', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const givenUpdateId = 'fire-update-1';
  const handle = await startWorkflow(runtimeRegisteredUpdateWorkflow);
  await handle.executeUpdate(fireUpdate, { updateId: givenUpdateId });
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const outside = labelMarkerId(expectedGroupId(runId, 'outside'));
  const inside = labelMarkerId(expectedGroupId(runId, 'inside'));
  const update = updateMarker(givenUpdateId);

  t.is(eventsOfKind(history, 'scheduleActivity').length, 5);

  // EG-IMPLICIT-60: A runtime-registered update handler does not inherit its registration scope
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'fromUpdate')), set(update));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'inOutside')), set(outside)); // Control

  // EG-IMPLICIT-61: An explicit scope composes with a runtime-registered update handler's implicit scope
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'fromUpdateScoped')), set(update, inside));

  // EG-IMPLICIT-80: Update implicit scope does not leak to commands in the Workflow main function
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'fromMainBefore')), []);
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'fromMainAfter')), []);
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

  const handle = await startWorkflow(defaultHandlersWorkflow);
  const updateId = 'default-update-1';

  // Names for which no handler is registered, so that the default handlers are what run.
  await handle.signal('some-unregistered-signal');
  await handle.executeUpdate('some-unregistered-update', { updateId, args: [] });

  await handle.result();
  const history = await handle.fetchHistory();

  t.is(eventsOfKind(history, 'scheduleActivity').length, 2);

  // EG-IMPLICIT-20: A catch-all signal handler carries the signaled event's marker
  const signal = eventMarker(singleSignaledEventId(history));
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'fromSignal')), set(signal));

  // EG-IMPLICIT-70: A catch-all update handler carries the update ID
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'fromUpdate')), set(updateMarker(updateId)));
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// 5. Event Group Marker Aggregation (`EG-AGGREGATION`)
////////////////////////////////////////////////////////////////////////////////////////////////////

export async function markerAggregationWorkflow(): Promise<void> {
  // Same label, no user-provided id => one group, and so one marker
  const a1 = createEventGroup('aaa');
  const a2 = createEventGroup('aaa');

  // Two labels, one user-provided id => also one group, and so also one marker
  const b1 = createEventGroup('bbb1', { id: 'b-id' });
  const b2 = createEventGroup('bbb2', { id: 'b-id' });

  // Duplicate markers directly attached to one command
  await scheduleActivity('direct-duplicates', { eventGroups: [a2, b1, a1, b1, a2, a1] }); // Expect: { a1, b1 }

  // Nested scopes of duplicate groups
  await a1.withScope(async () => {
    await a2.withScope(async () => {
      await b1.withScope(async () => {
        await scheduleActivity('nested-scopes', {}); // Expect: { a1, b1 }
      });
    });
  });

  // Scoped and directly attached markers
  await a1.withScope(async () => {
    await b1.withScope(async () => {
      await scheduleActivity('scope-and-direct-b', { eventGroups: [b1] }); // Expect: { a1, b1 }
      await scheduleActivity('scope-and-direct-a-b', { eventGroups: [b1, a1] }); // Expect: { a1, b1 }
    });
  });

  // The same group instance, listed twice in one call
  await scheduleActivity('same-instance-twice', { eventGroups: [a1, a1] }); // Expect: { a1 }

  // Two groups sharing an id but not a label
  await scheduleActivity('same-id-direct', { eventGroups: [b1, b2] }); // Expect: { b1 }
  await b1.withScope(async () => {
    await scheduleActivity('same-id-scope-and-direct', { eventGroups: [b2] }); // Expect: { b1 }
  });
}

test('Markers dedupe by ID, whether scoped or directly attached', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(markerAggregationWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const aId = expectedGroupId(handle.firstExecutionRunId, 'aaa');
  const ab = set(labelMarkerId(aId), labelMarkerId('b-id'));

  t.is(eventsOfKind(history, 'scheduleActivity').length, 7);

  // EG-AGGREGATION-00: Duplicate markers directly attached to one command collapse into a set
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'direct-duplicates')), ab);

  // EG-AGGREGATION-01: Nested scopes of duplicate groups collapse into a set
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'nested-scopes')), ab);

  // EG-AGGREGATION-02: Scoped and directly attached markers collapse into one set
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'scope-and-direct-b')), ab);
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'scope-and-direct-a-b')), ab);

  // EG-AGGREGATION-03: The same group instance listed twice contributes one marker
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'same-instance-twice')), set(labelMarkerId(aId)));

  // EG-AGGREGATION-04: Aggregation keys label markers by ID, disregarding labels
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'same-id-direct')), set(labelMarkerId('b-id')));
  t.deepEqual(
    markerIdsOf(singleEvent(history, 'scheduleActivity', 'same-id-scope-and-direct')),
    set(labelMarkerId('b-id'))
  );
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// 6. Command Type Coverage (`EG-COMMANDS`)
//
// EG-COMMANDS-23 and EG-COMMANDS-24 do not apply: Core-based SDKs have no `version` or `sideEffect` API.
////////////////////////////////////////////////////////////////////////////////////////////////////

export async function timerCommandsWorkflow(): Promise<void> {
  const direct = createEventGroup('direct');
  const scope = createEventGroup('scope');

  await scope.withScope(async () => {
    await sleep('1ms', { eventGroups: [direct] }); // Expect: { direct, scope }
  });
}

test('Timer commands carry markers', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(timerCommandsWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const direct = labelMarkerId(expectedGroupId(runId, 'direct'));
  const scope = labelMarkerId(expectedGroupId(runId, 'scope'));

  // EG-COMMANDS-00: Timer commands carry markers
  t.deepEqual(markerIdsOf(singleEvent(history, 'startTimer')), set(direct, scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function timerCancellationWorkflow(): Promise<void> {
  const direct = createEventGroup('direct');
  const scope = createEventGroup('scope');

  await scope.withScope(async () => {
    await CancellationScope.withTimeout('1ms', async () => {
      try {
        await sleep('60s', { eventGroups: [direct] }); // Expect: { direct, scope }
      } catch (err) {
        if (!workflow.isCancellation(err)) throw err;
      }
    });
  });
}

test("Timer Cancellation commands carry Timer's markers", async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(timerCancellationWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const direct = labelMarkerId(expectedGroupId(runId, 'direct'));
  const scope = labelMarkerId(expectedGroupId(runId, 'scope'));

  const timers = eventsOfKind(history, 'startTimer');
  t.is(timers.length, 2);

  // EG-COMMANDS-00-CANCEL: Timer Cancellation commands carry Timer's markers
  // The timeout timer takes no options, so ambient scope only;
  // the cancelled 60s timer and its cancel inherit { direct, scope }.
  t.deepEqual(markerIdsOf(timers[0]), set(scope));
  t.deepEqual(markerIdsOf(timers[1]), set(direct, scope));
  t.deepEqual(markerIdsOf(singleEvent(history, 'cancelTimer')), set(direct, scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function jsTimeoutCancellationWorkflow(): Promise<void> {
  const scope = createEventGroup('scope');
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  await scope.withScope(async () => {
    // `setTimeout` exposes no options argument, so the ambient scope is all it can carry.
    timeoutHandle = setTimeout(() => undefined, 60_000);
  });

  // Force a Workflow Task boundary so the timer command reaches the server before it is cleared.
  await sleep('1ms');
  clearTimeout(timeoutHandle);
}

test('JS setTimeout/clearTimeout carry ambient markers', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(jsTimeoutCancellationWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const scope = labelMarkerId(expectedGroupId(handle.firstExecutionRunId, 'scope'));
  const timers = eventsOfKind(history, 'startTimer');
  t.is(timers.length, 2);

  // Extra: TypeScript's `setTimeout` is backed by a Temporal timer. The second timer is the
  // unscoped `sleep` that forces a Workflow Task boundary.
  t.deepEqual(markerIdsOf(timers[0]), set(scope));
  t.deepEqual(markerIdsOf(timers[1]), []);
  t.deepEqual(markerIdsOf(singleEvent(history, 'cancelTimer')), set(scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function waitConditionTimerWorkflow(): Promise<void> {
  const direct = createEventGroup('direct');
  const scope = createEventGroup('scope');

  await scope.withScope(async () => {
    await workflow.condition(() => false, '1ms', { eventGroups: [direct] }); // Expect: { direct, scope }
  });
}

test('Wait conditions with timeouts carry markers to their timers', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(waitConditionTimerWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const direct = labelMarkerId(expectedGroupId(runId, 'direct'));
  const scope = labelMarkerId(expectedGroupId(runId, 'scope'));

  // EG-COMMANDS-01: Wait conditions with timeouts carry markers to their timers
  t.deepEqual(markerIdsOf(singleEvent(history, 'startTimer')), set(direct, scope));
});

export async function activityCommandsWorkflow(): Promise<void> {
  const direct = createEventGroup('direct');
  const scope = createEventGroup('scope');

  await scope.withScope(async () => {
    await scheduleActivity('activity', { eventGroups: [direct] }); // Expect: { direct, scope }
  });
}

test('Activity commands carry markers', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(activityCommandsWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const direct = labelMarkerId(expectedGroupId(runId, 'direct'));
  const scope = labelMarkerId(expectedGroupId(runId, 'scope'));

  // EG-COMMANDS-02: Activity commands carry markers
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'activity')), set(direct, scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function activityCancellationWorkflow(): Promise<void> {
  const direct = createEventGroup('direct');
  const scope = createEventGroup('scope');

  await scope.withScope(async () => {
    await CancellationScope.withTimeout('1ms', () =>
      scheduleActivity('activity-cancelled-sleeper', {
        args: [8000],
        cancellationType: 'TRY_CANCEL',
        eventGroups: [direct],
      })
    ).catch((err) => {
      if (!workflow.isCancellation(err)) throw err;
    });
  });
}

test("Activity Cancellation commands carry Activity's markers", async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(activityCancellationWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const direct = labelMarkerId(expectedGroupId(runId, 'direct'));
  const scope = labelMarkerId(expectedGroupId(runId, 'scope'));

  // EG-COMMANDS-02-CANCEL: Activity Cancellation commands carry Activity's markers
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleActivity', 'activity-cancelled-sleeper')), set(direct, scope));
  t.deepEqual(markerIdsOf(singleEvent(history, 'requestCancelActivity')), set(direct, scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function localActivityCommandsWorkflow(): Promise<void> {
  const direct = createEventGroup('direct');
  const scope = createEventGroup('scope');

  await scope.withScope(async () => {
    await scheduleLocalActivity('local-activity', { eventGroups: [direct] }); // Expect: { direct, scope }
  });
}

test('Local activity commands carry markers', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(localActivityCommandsWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const direct = labelMarkerId(expectedGroupId(runId, 'direct'));
  const scope = labelMarkerId(expectedGroupId(runId, 'scope'));

  // EG-COMMANDS-03: Local Activity commands carry markers
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleLocalActivity')), set(direct, scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function localActivityCancellationWorkflow(): Promise<void> {
  const direct = createEventGroup('direct');
  const scope = createEventGroup('scope');

  // Extra groups distinguish the trigger from the cancelled LA.
  const cancelTrigger = createEventGroup('cancel-trigger');
  const cancelledLa = createEventGroup('cancelled-la');

  await scope.withScope(async () => {
    const cancellation = new CancellationScope({ cancellable: true });
    await cancellation.run(async () => {
      await Promise.all([
        scheduleLocalActivity('cancel-trigger', { eventGroups: [direct, cancelTrigger] }).then(() =>
          cancellation.cancel()
        ),
        scheduleLocalActivity('cancelled-local-activity-sleeper', {
          args: [8000],
          eventGroups: [direct, cancelledLa],
        }).catch((err) => {
          if (!workflow.isCancellation(err)) throw err;
        }),
      ]);
    });
  });
}

test("Local activity cancellation commands carry the LA's markers", async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(localActivityCancellationWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const direct = labelMarkerId(expectedGroupId(runId, 'direct'));
  const scope = labelMarkerId(expectedGroupId(runId, 'scope'));
  const cancelTrigger = labelMarkerId(expectedGroupId(runId, 'cancel-trigger'));
  const cancelledLa = labelMarkerId(expectedGroupId(runId, 'cancelled-la'));

  const las = eventsOfKind(history, 'scheduleLocalActivity');
  t.is(las.length, 2);

  // EG-COMMANDS-03-CANCEL: Local Activity Cancellation commands carry LA's markers
  t.deepEqual(markerIdsOf(las.find((e) => markerIdsOf(e)!.includes(cancelTrigger))), set(direct, scope, cancelTrigger));
  t.deepEqual(markerIdsOf(las.find((e) => markerIdsOf(e)!.includes(cancelledLa))), set(direct, scope, cancelledLa));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function localActivityBackoffWorkflow(): Promise<void> {
  const direct = createEventGroup('direct');
  const scope = createEventGroup('scope');

  await scope.withScope(async () => {
    // A retry interval past `localRetryThreshold` is what makes Core hand the retry back as a
    // backoff timer. The plan uses a 10s interval against a 5s Workflow Task timeout; lowering the
    // threshold reaches the same branch without waiting that long.
    await scheduleLocalActivity('backoff-local-activity-fail-first-attempt', {
      eventGroups: [direct],
      localRetryThreshold: '1ms',
      retry: { initialInterval: '1s', backoffCoefficient: 1, maximumAttempts: 2 },
    });
  });
}

test("Local activity retry backoff timer carries the LA's markers", async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(localActivityBackoffWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const direct = labelMarkerId(expectedGroupId(runId, 'direct'));
  const scope = labelMarkerId(expectedGroupId(runId, 'scope'));

  const las = eventsOfKind(history, 'scheduleLocalActivity');
  t.is(las.length, 2);

  // EG-COMMANDS-03-BACKOFF: Local Activity Retry Backoff Timer carries LA's markers
  t.deepEqual(markerIdsOf(las[0]), set(direct, scope));
  t.deepEqual(markerIdsOf(singleEvent(history, 'startTimer')), set(direct, scope));
  t.deepEqual(markerIdsOf(las[1]), set(direct, scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function childWorkflowCommandsWorkflow(): Promise<void> {
  const direct = createEventGroup('direct');
  const scope = createEventGroup('scope');

  await scope.withScope(async () => {
    await startChild(noopWorkflow, { eventGroups: [direct] }); // Expect: { direct, scope }
  });
}

test('Child workflow commands carry markers', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(childWorkflowCommandsWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const direct = labelMarkerId(expectedGroupId(runId, 'direct'));
  const scope = labelMarkerId(expectedGroupId(runId, 'scope'));

  // EG-COMMANDS-04: Child Workflow commands carry markers
  t.deepEqual(markerIdsOf(singleEvent(history, 'startChildWorkflowExecution', 'noopWorkflow')), set(direct, scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function childWorkflowCancellationWorkflow(): Promise<void> {
  const direct = createEventGroup('direct');
  const scope = createEventGroup('scope');

  await scope.withScope(async () => {
    await CancellationScope.withTimeout('1ms', async () => {
      const child = await startChild(sleepWorkflow, {
        eventGroups: [direct],
        cancellationType: workflow.ChildWorkflowCancellationType.WAIT_CANCELLATION_REQUESTED,
      });
      await child.result();
    }).catch((err) => {
      if (!workflow.isCancellation(err)) throw err;
    });
  });
}

test("Child workflow cancellation commands carry the child workflow's markers", async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(childWorkflowCancellationWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const direct = labelMarkerId(expectedGroupId(runId, 'direct'));
  const scope = labelMarkerId(expectedGroupId(runId, 'scope'));

  // EG-COMMANDS-04-CANCEL: Child Workflow Cancellation commands carry the Child Workflow's markers
  t.deepEqual(markerIdsOf(singleEvent(history, 'startChildWorkflowExecution', 'sleepWorkflow')), set(direct, scope));
  t.deepEqual(markerIdsOf(singleEvent(history, 'requestCancelExternalWorkflowExecution')), set(direct, scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function nexusOperationCommandsWorkflow(nexusEndpoint: string): Promise<void> {
  const nexusClient = workflow.createNexusServiceClient({ endpoint: nexusEndpoint, service: nexusService });
  const direct = createEventGroup('direct');
  const scope = createEventGroup('scope');

  await scope.withScope(async () => {
    await nexusClient.executeOperation('noopOp', undefined, { eventGroups: [direct] }); // Expect: { direct, scope }
  });
}

test('Nexus operation commands carry markers', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(nexusOperationCommandsWorkflow, { args: [t.context.nexusEndpointName] });
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const direct = labelMarkerId(expectedGroupId(runId, 'direct'));
  const scope = labelMarkerId(expectedGroupId(runId, 'scope'));

  // EG-COMMANDS-05: Nexus Operation commands carry markers
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleNexusOperation', 'noopOp')), set(direct, scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function nexusOperationCancellationWorkflow(nexusEndpoint: string): Promise<void> {
  const nexusClient = workflow.createNexusServiceClient({ endpoint: nexusEndpoint, service: nexusService });
  const direct = createEventGroup('direct');
  const scope = createEventGroup('scope');

  await scope.withScope(async () => {
    await CancellationScope.withTimeout('1ms', () =>
      nexusClient.executeOperation('sleeperOp', 8000, {
        cancellationType: 'TRY_CANCEL',
        eventGroups: [direct],
      })
    ).catch((err) => {
      if (!workflow.isCancellation(err)) throw err;
    });
  });
}

test("Nexus operation cancellation commands carry the Nexus operation's markers", async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(nexusOperationCancellationWorkflow, { args: [t.context.nexusEndpointName] });
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const direct = labelMarkerId(expectedGroupId(runId, 'direct'));
  const scope = labelMarkerId(expectedGroupId(runId, 'scope'));

  // EG-COMMANDS-05-CANCEL: Nexus Operation Cancellation commands carry the Nexus Operation's markers
  t.deepEqual(markerIdsOf(singleEvent(history, 'scheduleNexusOperation', 'sleeperOp')), set(direct, scope));
  t.deepEqual(markerIdsOf(singleEvent(history, 'requestCancelNexusOperation')), set(direct, scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function signalExternalWorkflowCommandsWorkflow(): Promise<void> {
  const scope = createEventGroup('scope');

  await scope.withScope(async () => {
    // Targeting a missing Workflow keeps this self-contained: the server records the Initiated
    // event, then fails the request. TypeScript's external-signal API does not yet accept
    // `eventGroups`, so only the ambient scope is asserted (GAP vs the plan's Execute snippet).
    await workflow
      .getExternalWorkflowHandle('event-groups-no-such-workflow')
      .signal('signal')
      .catch(() => undefined);
  });
}

test('Signal external workflow commands carry markers', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(signalExternalWorkflowCommandsWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const scope = labelMarkerId(expectedGroupId(runId, 'scope'));

  // EG-COMMANDS-06: Signal External Workflow commands carry markers
  // Ambient only; direct attach is a known API gap.
  t.deepEqual(markerIdsOf(singleEvent(history, 'signalExternalWorkflowExecution')), set(scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function cancelExternalWorkflowCommandsWorkflow(): Promise<void> {
  const scope = createEventGroup('scope');

  await scope.withScope(async () => {
    // Same missing-Workflow trick as EG-COMMANDS-06. Direct attach is likewise a known API gap.
    await workflow
      .getExternalWorkflowHandle('event-groups-no-such-workflow')
      .cancel()
      .catch(() => undefined);
  });
}

test('Cancel external workflow commands carry markers', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(cancelExternalWorkflowCommandsWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const runId = handle.firstExecutionRunId;
  const scope = labelMarkerId(expectedGroupId(runId, 'scope'));

  // EG-COMMANDS-07: Cancel External Workflow commands carry markers
  // Ambient only; direct attach is a known API gap.
  t.deepEqual(markerIdsOf(singleEvent(history, 'requestCancelExternalWorkflowExecution')), set(scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function modifyWorkflowPropertiesWorkflow(): Promise<void> {
  const scope = createEventGroup('scope');

  await scope.withScope(async () => {
    workflow.upsertMemo({ 'some-key': 'some-value' }); // Expect: { scope }
  });
}

test('Modify Workflow Properties commands carry the ambient scope', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(modifyWorkflowPropertiesWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const scope = labelMarkerId(expectedGroupId(handle.firstExecutionRunId, 'scope'));

  // EG-COMMANDS-20: Modify Workflow Properties commands carry the ambient scope
  t.deepEqual(markerIdsOf(singleEvent(history, 'modifyWorkflowProperties')), set(scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function upsertSearchAttributesWorkflow(): Promise<void> {
  const scope = createEventGroup('scope');

  await scope.withScope(async () => {
    // The key must be one of those the test environment registers on the namespace (`defaultSAKeys`).
    workflow.upsertSearchAttributes([
      { key: defineSearchAttributeKey('CustomBoolField', SearchAttributeType.BOOL), value: false },
    ]);
  });
}

test('Upsert search attribute commands carry the ambient scope', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(upsertSearchAttributesWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const scope = labelMarkerId(expectedGroupId(handle.firstExecutionRunId, 'scope'));

  // EG-COMMANDS-21: Upsert Search Attribute commands carry the ambient scope
  t.deepEqual(markerIdsOf(singleEvent(history, 'upsertWorkflowSearchAttributes')), set(scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function patchCommandsWorkflow(): Promise<void> {
  const scope = createEventGroup('scope');

  await scope.withScope(async () => {
    workflow.patched('my-patch-1');
    workflow.deprecatePatch('my-patch-2');
  });
}

test('Patch commands carry the ambient scope', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);

  const handle = await startWorkflow(patchCommandsWorkflow);
  await handle.result();
  const history = await handle.fetchHistory();

  const scope = labelMarkerId(expectedGroupId(handle.firstExecutionRunId, 'scope'));

  // EG-COMMANDS-22: Patch commands carry the ambient scope
  const patchMarkers = eventsOfKind(history, 'recordMarker', 'core_patch');
  t.is(patchMarkers.length, 2);
  t.deepEqual(markerIdsOf(patchMarkers[0]), set(scope));
  t.deepEqual(markerIdsOf(patchMarkers[1]), set(scope));

  const upserts = eventsOfKind(history, 'upsertWorkflowSearchAttributes');
  t.is(upserts.length, 2);
  t.deepEqual(markerIdsOf(upserts[0]), set(scope));
  t.deepEqual(markerIdsOf(upserts[1]), set(scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function continueAsNewMarkersWorkflow(): Promise<void> {
  const direct = createEventGroup('direct');
  const scope = createEventGroup('scope');

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

  const runId = handle.firstExecutionRunId;
  const history = await client.workflow.getHandle(handle.workflowId, runId).fetchHistory();
  const direct = labelMarkerId(expectedGroupId(runId, 'direct'));
  const scope = labelMarkerId(expectedGroupId(runId, 'scope'));

  // EG-COMMANDS-40: Continue-As-New carries directly attached and ambient markers
  // Long form: options include directly attached groups.
  t.deepEqual(markerIdsOf(singleEvent(history, 'continueAsNewWorkflowExecution')), set(direct, scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

export async function continueAsNewShortFormMarkersWorkflow(done = false): Promise<void> {
  if (done) return;

  const scope = createEventGroup('scope');
  await scope.withScope(() => workflow.continueAsNew<typeof continueAsNewShortFormMarkersWorkflow>(true));
}

test('short-form continueAsNew carries ambient markers only', async (t) => {
  const { startWorkflow } = sharedWorkerHelpers(t);
  const { client } = t.context.env;

  const handle = await startWorkflow(continueAsNewShortFormMarkersWorkflow);
  await handle.result();

  const runId = handle.firstExecutionRunId;
  const history = await client.workflow.getHandle(handle.workflowId, runId).fetchHistory();
  const scope = labelMarkerId(expectedGroupId(runId, 'scope'));

  // EG-COMMANDS-40: Continue-As-New carries directly attached and ambient markers
  // Short form: no options argument.
  t.deepEqual(markerIdsOf(singleEvent(history, 'continueAsNewWorkflowExecution')), set(scope));
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// GENERIC WORKFLOWS, ACTIVITIES AND NEXUS SERVICES
////////////////////////////////////////////////////////////////////////////////////////////////////

export const fireSignal = workflow.defineSignal('fire');
export const unblockSignal = workflow.defineSignal('unblock');
export const fireUpdate = workflow.defineUpdate<void, []>('fire');

// A workflow that does nothing at all, for cases that need a workflow type but no behavior.
export async function noopWorkflow(): Promise<void> {
  // Nothing to do.
}

// A workflow that simply sleeps for 30 seconds.
export async function sleepWorkflow(): Promise<void> {
  await sleep('30s');
}

// The activity type name is recorded on `ActivityTaskScheduled`, which is how assertions tell
// otherwise identical commands apart. Call sites therefore make up whatever name reads best, and
// use the untyped `proxyActivities` so that they can: the Worker resolves every unregistered type
// to its `default` activity, so a name only appears here when it needs behavior of its own.
function testActivities(): UntypedActivities {
  const noop = async (): Promise<void> => undefined;
  const backoffLocalActivityFailFirstAttempt = async (): Promise<void> => {
    // Fails on the first attempt only so the LA is retried with a backoff timer.
    if (activityInfo().attempt === 1) {
      throw new Error('flaky activity failing on purpose');
    }
  };
  // Long enough that a cancellation requested a millisecond in cannot lose the race against the
  // activity resolving on its own.
  const sleeper = async (ms: number): Promise<void> => {
    await activitySleep(ms);
  };
  return {
    default: noop,

    // FIXME: LA should be able to invoke an activity type that isn't explicitly
    //        registered if a default activity has been registered.
    // Local activities can't invoke an activity type that isn't explicitly registered: the worker
    // the worker checks the type name against registered names and fails the WFT on a miss.
    // So here they are:
    noop,
    'local-activity': noop,
    'cancel-trigger': noop,

    'backoff-local-activity-fail-first-attempt': backoffLocalActivityFailFirstAttempt,

    sleeper,
    'activity-cancelled-sleeper': sleeper,
    'cancelled-local-activity-sleeper': sleeper,
  };
}

const nexusService = nexus.service('event-groups-test-service', {
  noopOp: nexus.operation<void, void>(),
  sleeperOp: nexus.operation<number, void>(),
} as const);

function makeNexusServiceHandler() {
  return nexus.serviceHandler(nexusService, {
    noopOp: async (_ctx, _input): Promise<void> => undefined,
    // The Nexus counterpart of the `sleeper` activity: long enough that a cancellation cannot lose
    // the race against the operation resolving on its own.
    sleeperOp: async (ctx, ms): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, ms);
        ctx.abortSignal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            reject(ctx.abortSignal.reason);
          },
          { once: true }
        );
      });
    },
  });
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// The shared worker
//
// Almost every test here needs the same worker: the file's own Workflow bundle, the no-op activities
// and the Nexus service handler. Rather than build one per test, the file runs a single worker for
// its whole lifetime. Only two tests opt out, each spinning its own worker for a reason stated at
// the test: the payload codec and custom payload converter tests, whose workers must be configured
// differently.
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

////////////////////////////////////////////////////////////////////////////////////////////////////
// TEST HELPERS
////////////////////////////////////////////////////////////////////////////////////////////////////

function scheduleActivity(
  name: string,
  { args, ...rest }: { args?: unknown[] } & workflow.ActivityOptions
): Promise<void> {
  return workflow.scheduleActivity(name, args ?? [], {
    scheduleToCloseTimeout: '10s',
    ...rest,
  });
}

function scheduleLocalActivity(
  name: string,
  { args, ...rest }: { args?: unknown[] } & workflow.LocalActivityOptions
): Promise<void> {
  return workflow.scheduleLocalActivity(name, args ?? [], {
    startToCloseTimeout: '10s',
    ...rest,
  });
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// HISTORY HELPERS
////////////////////////////////////////////////////////////////////////////////////////////////////

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
  timerCanceledEventAttributes: 'cancelTimer',
  activityTaskScheduledEventAttributes: 'scheduleActivity',
  activityTaskCancelRequestedEventAttributes: 'requestCancelActivity',
  startChildWorkflowExecutionInitiatedEventAttributes: 'startChildWorkflowExecution',
  nexusOperationScheduledEventAttributes: 'scheduleNexusOperation',
  nexusOperationCancelRequestedEventAttributes: 'requestCancelNexusOperation',
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

// Markers are rendered as strings so that failures print readably and collections can be compared
// as sets, by sorting. `renderMarkerId` omits the label for cases where two groups share an id
// but not a label and which label is emitted is unspecified.
function renderMarkerId(m: CapturedMarker): string {
  if (m.inboundEventId !== undefined) return `event:${m.inboundEventId}`;
  if (m.inboundUpdateId !== undefined) return `update:${m.inboundUpdateId}`;
  return `label:${m.id}`;
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

/** Expected marker set, in the same normalized form as {@link markerIdsOf}. */
function set(...markers: string[]): string[] {
  return [...markers].sort();
}

function eventMarker(eventId: number): string {
  return `event:${eventId}`;
}

function updateMarker(updateId: string): string {
  return `update:${updateId}`;
}

function labelMarkerId(id: string): string {
  return `label:${id}`;
}

function eventsOfKind(history: temporal.api.history.v1.IHistory, kind: string, name?: string): CapturedEvent[] {
  return capturedEventsFromHistory(history).filter((e) => e.kind === kind && (name === undefined || e.name === name));
}

/** The single event of the given kind (and command detail); throws if there isn't exactly one. */
function singleEvent(history: temporal.api.history.v1.IHistory, kind: string, name?: string): CapturedEvent {
  const matches = eventsOfKind(history, kind, name);
  if (matches.length !== 1) {
    const captured = capturedEventsFromHistory(history).map((e) => ({ kind: e.kind, name: e.name }));
    throw new Error(
      `Expected exactly one ${kind}${name === undefined ? '' : `/${name}`} event, got ${matches.length} ` +
        `(events: ${JSON.stringify(captured)})`
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
