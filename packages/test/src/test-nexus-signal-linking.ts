/**
 * Verifies bidirectional history-event link propagation when a Nexus Operation handler interacts
 * with a Workflow via signal and signalWithStart.
 *
 * Two directions are covered:
 *
 *  - Forward (caller -> callee): the inbound Nexus task links are forwarded onto the outgoing
 *    signal / signalWithStart request so the callee's WorkflowExecutionSignaled (and, for
 *    signalWithStart, WorkflowExecutionStarted) events link back to the caller's
 *    NexusOperationScheduled event. This is asserted unconditionally.
 *
 *  - Backward (callee -> caller): the server returns a backlink on the signal / signalWithStart
 *    response which the handler stashes on the operation context; the Nexus task handler drains it
 *    onto the StartOperationResponse so the caller's NexusOperationCompleted (sync) or
 *    NexusOperationStarted (async) event links to the callee's WorkflowExecutionSignaled event.
 *    The backlink is only produced by servers that support CHASM signal backlinks
 *    (`history.enableCHASMSignalBacklinks=true`, requires `history.enableChasm=true`, server 1.31+).
 *    The test server below is launched with both flags enabled, so the backward assertions are
 *    unconditional: a dropped response link must fail the test.
 *
 * Mirrors the Java SDK's `SignalOperationLinkingTest`.
 */
import { randomUUID } from 'crypto';
import * as nexus from 'nexus-rpc';
import { temporal } from '@temporalio/proto';
import * as temporalnexus from '@temporalio/nexus';
import * as workflow from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';

const { EventType } = temporal.api.enums.v1;

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowEnvironmentOpts: {
    server: {
      extraArgs: [
        '--dynamic-config-value',
        'nexusoperation.enableStandalone=true',
        '--dynamic-config-value',
        'system.refreshNexusEndpointsMinWait="0s"',
        '--dynamic-config-value',
        'history.enableChasm=true',
        '--dynamic-config-value',
        'history.enableCHASMSignalBacklinks=true',
      ],
    },
  },
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// Shared callee Workflow

export const pingSignal = workflow.defineSignal<[string]>('ping');

/**
 * Target Workflow that the Nexus operation handlers signal. It collects `expectedSignals` ping
 * payloads and returns them joined, so each test can assert which signals actually landed.
 */
export async function callee(expectedSignals: number): Promise<string> {
  const received: string[] = [];
  workflow.setHandler(pingSignal, (msg: string) => {
    received.push(msg);
  });
  await workflow.condition(() => received.length >= expectedSignals);
  return received.join(',');
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Assertion helpers

function getAllEventsOfType(
  history: temporal.api.history.v1.IHistory,
  type: temporal.api.enums.v1.EventType
): temporal.api.history.v1.IHistoryEvent[] {
  return (history.events ?? []).filter((e) => e.eventType === type);
}

/**
 * Assert that the callee history has `expectedCount` WorkflowExecutionSignaled events, each linked
 * back to the caller's NexusOperationScheduled event.
 */
function assertForwardLinks(
  t: any,
  calleeHistory: temporal.api.history.v1.IHistory,
  callerWorkflowId: string,
  expectedCount: number
): void {
  const signaledEvents = getAllEventsOfType(calleeHistory, EventType.EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED);
  t.is(signaledEvents.length, expectedCount, `expected ${expectedCount} WorkflowExecutionSignaled events on callee`);
  for (const signaled of signaledEvents) {
    t.true((signaled.links?.length ?? 0) >= 1, 'expected a link on each WorkflowExecutionSignaled event');
    const link = signaled.links![0].workflowEvent;
    t.is(link?.workflowId, callerWorkflowId, 'signaled-event link should reference the caller workflow');
    t.is(link?.eventRef?.eventType, EventType.EVENT_TYPE_NEXUS_OPERATION_SCHEDULED);
  }
}

/**
 * Assert that a single caller-side event carries a response link to a callee's
 * WorkflowExecutionSignaled event. The server may key these via either an EventReference or a
 * RequestIdReference; accept either oneof variant. Returns the referenced callee workflowId.
 */
function assertResponseLink(t: any, event: temporal.api.history.v1.IHistoryEvent): string {
  t.true((event.links?.length ?? 0) >= 1, `expected a signal-event response link on ${event.eventType}`);
  const responseLink = event.links![0].workflowEvent;
  const responseLinkEventType = responseLink?.requestIdRef
    ? responseLink.requestIdRef.eventType
    : responseLink?.eventRef?.eventType;
  t.is(responseLinkEventType, EventType.EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED);
  return responseLink?.workflowId ?? '';
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Test: sync signalWithStart + signal on the same callee

const twoSyncService = nexus.service('twoSyncSignaling', {
  signalWithStart: nexus.operation<{ workflowId: string }, string>(),
  signal: nexus.operation<{ workflowId: string }, string>(),
});

export async function twoSyncCaller(endpoint: string, calleeWorkflowId: string): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: twoSyncService });
  const signalWithStartResult = await client.executeOperation('signalWithStart', { workflowId: calleeWorkflowId });
  const signalResult = await client.executeOperation('signal', { workflowId: calleeWorkflowId });
  return `${signalWithStartResult}|${signalResult}`;
}

function twoSyncServiceHandler(taskQueue: string) {
  const handlers: nexus.ServiceHandlerFor<typeof twoSyncService.operations> = {
    signalWithStart: new temporalnexus.TemporalOperationHandler<{ workflowId: string }, string>({
      async start(ctx, client, input) {
        await client.signalWithStartWorkflow<typeof callee, [string]>(callee, {
          workflowId: input.workflowId,
          taskQueue,
          args: [2],
          signal: pingSignal,
          signalArgs: ['first'],
        });
        return temporalnexus.TemporalOperationResult.sync('ok:signalWithStart');
      },
    }),
    signal: new temporalnexus.TemporalOperationHandler<{ workflowId: string }, string>({
      async start(ctx, client, input) {
        await client.signalWorkflow(input.workflowId, pingSignal.name, ['second']);
        return temporalnexus.TemporalOperationResult.sync('ok:signal');
      },
    }),
  };
  return nexus.serviceHandler(twoSyncService, handlers);
}

test('signal and signalWithStart from a Nexus handler forward links and propagate response links', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint, taskQueue } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();
  const calleeWorkflowId = `callee-${randomUUID()}`;

  const worker = await createWorker({
    nexusServices: [twoSyncServiceHandler(taskQueue)],
  });

  await worker.runUntil(async () => {
    const callerHandle = await startWorkflow(twoSyncCaller, {
      args: [endpointName, calleeWorkflowId],
    });
    t.is(await callerHandle.result(), 'ok:signalWithStart|ok:signal');

    const calleeHandle = client.workflow.getHandle(calleeWorkflowId);
    t.is(await calleeHandle.result(), 'first,second');

    const callerHistory = await callerHandle.fetchHistory();
    const calleeHistory = await calleeHandle.fetchHistory();

    assertForwardLinks(t, calleeHistory, callerHandle.workflowId, 2);

    const completedEvents = getAllEventsOfType(callerHistory, EventType.EVENT_TYPE_NEXUS_OPERATION_COMPLETED);
    t.is(completedEvents.length, 2, 'expected two NexusOperationCompleted events on the caller');
    // The test server runs with CHASM signal backlinks enabled, so a response link must be present
    // on every NexusOperationCompleted event.
    for (const completed of completedEvents) {
      t.is(assertResponseLink(t, completed), calleeWorkflowId);
    }
  });
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// Test: async signalWithStart propagates the backlink onto NexusOperationStarted

const asyncSignalService = nexus.service('asyncSignaling', {
  signalWithStart: nexus.operation<{ workflowId: string }, string>(),
});

export async function asyncCaller(endpoint: string, calleeWorkflowId: string): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: asyncSignalService });
  // startOperation resolves once the operation is Started (the event that carries the backlink for
  // the async path); we intentionally do not await its eventual result.
  await client.startOperation('signalWithStart', { workflowId: calleeWorkflowId });
  return 'async-started';
}

function asyncSignalServiceHandler(taskQueue: string) {
  const handlers: nexus.ServiceHandlerFor<typeof asyncSignalService.operations> = {
    signalWithStart: new temporalnexus.TemporalOperationHandler<{ workflowId: string }, string>({
      async start(ctx, client, input) {
        await client.signalWithStartWorkflow<typeof callee, [string]>(callee, {
          workflowId: input.workflowId,
          taskQueue,
          args: [1],
          signal: pingSignal,
          signalArgs: ['async-signal'],
        });
        return temporalnexus.TemporalOperationResult.async(`async-op-${randomUUID()}`);
      },
    }),
  };
  return nexus.serviceHandler(asyncSignalService, handlers);
}

test('async Nexus operation that signals propagates the response link onto NexusOperationStarted', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint, taskQueue } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();
  const calleeWorkflowId = `async-callee-${randomUUID()}`;

  const worker = await createWorker({
    nexusServices: [asyncSignalServiceHandler(taskQueue)],
  });

  await worker.runUntil(async () => {
    const callerHandle = await startWorkflow(asyncCaller, {
      args: [endpointName, calleeWorkflowId],
    });
    t.is(await callerHandle.result(), 'async-started');

    const calleeHandle = client.workflow.getHandle(calleeWorkflowId);
    t.is(await calleeHandle.result(), 'async-signal');

    const callerHistory = await callerHandle.fetchHistory();
    const calleeHistory = await calleeHandle.fetchHistory();

    assertForwardLinks(t, calleeHistory, callerHandle.workflowId, 1);

    const startedEvents = getAllEventsOfType(callerHistory, EventType.EVENT_TYPE_NEXUS_OPERATION_STARTED);
    t.is(startedEvents.length, 1, 'expected exactly one NexusOperationStarted event for the async op');
    // The test server runs with CHASM signal backlinks enabled, so the response link must be present
    // on the NexusOperationStarted event.
    t.is(assertResponseLink(t, startedEvents[0]), calleeWorkflowId);
  });
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// Test: one operation signaling multiple callees lands a response link per callee

const multiSignalService = nexus.service('multiSignaling', {
  signalMany: nexus.operation<{ workflowIds: string[] }, string>(),
});

export async function multiCaller(endpoint: string, calleeWorkflowIds: string[]): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: multiSignalService });
  return await client.executeOperation('signalMany', { workflowIds: calleeWorkflowIds });
}

function multiSignalServiceHandler(taskQueue: string) {
  const handlers: nexus.ServiceHandlerFor<typeof multiSignalService.operations> = {
    signalMany: new temporalnexus.TemporalOperationHandler<{ workflowIds: string[] }, string>({
      async start(ctx, client, input) {
        for (const workflowId of input.workflowIds) {
          await client.signalWithStartWorkflow<typeof callee, [string]>(callee, {
            workflowId,
            taskQueue,
            args: [1],
            signal: pingSignal,
            signalArgs: ['multi-signal'],
          });
        }
        return temporalnexus.TemporalOperationResult.sync('ok:multi');
      },
    }),
  };
  return nexus.serviceHandler(multiSignalService, handlers);
}

test('one Nexus operation signaling multiple callees lands a response link per callee', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint, taskQueue } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();
  const calleeIds = [`multicallee-a-${randomUUID()}`, `multicallee-b-${randomUUID()}`, `multicallee-c-${randomUUID()}`];

  const worker = await createWorker({
    nexusServices: [multiSignalServiceHandler(taskQueue)],
  });

  await worker.runUntil(async () => {
    const callerHandle = await startWorkflow(multiCaller, {
      args: [endpointName, calleeIds],
    });
    t.is(await callerHandle.result(), 'ok:multi');

    for (const calleeId of calleeIds) {
      t.is(await client.workflow.getHandle(calleeId).result(), 'multi-signal');
    }

    const callerHistory = await callerHandle.fetchHistory();

    for (const calleeId of calleeIds) {
      const calleeHistory = await client.workflow.getHandle(calleeId).fetchHistory();
      assertForwardLinks(t, calleeHistory, callerHandle.workflowId, 1);
    }

    const completedEvents = getAllEventsOfType(callerHistory, EventType.EVENT_TYPE_NEXUS_OPERATION_COMPLETED);
    t.is(completedEvents.length, 1, 'expected exactly one NexusOperationCompleted event');
    const completed = completedEvents[0];
    // The test server runs with CHASM signal backlinks enabled, so one response link per signaled
    // callee must be present on the NexusOperationCompleted event.
    t.is(completed.links!.length, calleeIds.length, 'expected one response link per signaled callee');
    const responseLinkWorkflowIds = completed.links!.map((l) => l.workflowEvent?.workflowId);
    for (const calleeId of calleeIds) {
      t.true(responseLinkWorkflowIds.includes(calleeId), `expected a response link referencing callee ${calleeId}`);
    }
  });
});
