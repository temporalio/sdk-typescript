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
// Service definition

const signalingService = nexus.service('signalingService', {
  // input is "<mode>:<calleeIds>"; see the handler below.
  operation: nexus.operation<string, string>(),
});

type SignalingServiceHandlers = nexus.ServiceHandlerFor<typeof signalingService.operations>;

const MODE_SIGNAL_WITH_START = 'signalWithStart';
const MODE_SIGNAL = 'signal';
const MODE_MULTI_SIGNAL_WITH_START = 'multi';
const MODE_ASYNC_SIGNAL_WITH_START = 'asyncSignalWithStart';

////////////////////////////////////////////////////////////////////////////////////////////////////
// Workflows

export async function callee(expectedSignals: number): Promise<string> {
  const received: string[] = [];
  workflow.setHandler(pingSignal, (msg: string) => {
    received.push(msg);
  });
  await workflow.condition(() => received.length >= expectedSignals);
  return received.join(',');
}

export const pingSignal = workflow.defineSignal<[string]>('ping');

export async function caller(endpoint: string, input: string): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: signalingService });
  const [mode, rest] = splitFirst(input, ':');

  switch (mode) {
    case 'twoSync': {
      const r1 = await client.executeOperation('operation', `${MODE_SIGNAL_WITH_START}:${rest}`);
      const r2 = await client.executeOperation('operation', `${MODE_SIGNAL}:${rest}`);
      return `${r1}|${r2}`;
    }
    case MODE_MULTI_SIGNAL_WITH_START:
      return await client.executeOperation('operation', `${MODE_MULTI_SIGNAL_WITH_START}:${rest}`);
    case MODE_ASYNC_SIGNAL_WITH_START: {
      // startOperation resolves once the operation is Started (the event that carries the backlink
      // for the async path); we intentionally do not await its eventual result.
      await client.startOperation('operation', `${MODE_ASYNC_SIGNAL_WITH_START}:${rest}`);
      return 'async-started';
    }
    default:
      throw new Error(`unknown mode: ${mode}`);
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Nexus service handler

function makeSignalingServiceHandler(taskQueue: string) {
  const handlers: SignalingServiceHandlers = {
    operation: new temporalnexus.TemporalOperationHandler<string, string>({
      async start(ctx, client, input) {
        const [mode, rest] = splitFirst(input, ':');
        switch (mode) {
          case MODE_SIGNAL_WITH_START:
            await client.signalWithStartWorkflow<typeof callee, [string]>(callee, {
              workflowId: rest,
              taskQueue,
              args: [2],
              signal: pingSignal,
              signalArgs: ['first'],
            });
            return temporalnexus.TemporalOperationResult.sync(`ok:${MODE_SIGNAL_WITH_START}`);
          case MODE_SIGNAL:
            await client.signalWorkflow(rest, pingSignal.name, ['second']);
            return temporalnexus.TemporalOperationResult.sync(`ok:${MODE_SIGNAL}`);
          case MODE_MULTI_SIGNAL_WITH_START:
            for (const id of rest.split(',')) {
              await client.signalWithStartWorkflow<typeof callee, [string]>(callee, {
                workflowId: id,
                taskQueue,
                args: [1],
                signal: pingSignal,
                signalArgs: ['multi-signal'],
              });
            }
            return temporalnexus.TemporalOperationResult.sync(`ok:multi:${rest}`);
          case MODE_ASYNC_SIGNAL_WITH_START:
            await client.signalWithStartWorkflow<typeof callee, [string]>(callee, {
              workflowId: rest,
              taskQueue,
              args: [1],
              signal: pingSignal,
              signalArgs: ['async-signal'],
            });
            return temporalnexus.TemporalOperationResult.async(`async-op-${randomUUID()}`);
          default:
            throw new nexus.HandlerError('BAD_REQUEST', `unknown mode: ${mode}`);
        }
      },
    }),
  };
  return nexus.serviceHandler(signalingService, handlers);
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

function splitFirst(s: string, sep: string): [string, string] {
  const idx = s.indexOf(sep);
  if (idx < 0) return [s, ''];
  return [s.slice(0, idx), s.slice(idx + sep.length)];
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Tests

test('signal and signalWithStart from a Nexus handler forward links and propagate response links', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint, taskQueue } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();
  const calleeWorkflowId = `callee-${randomUUID()}`;

  const worker = await createWorker({
    nexusServices: [makeSignalingServiceHandler(taskQueue)],
  });

  await worker.runUntil(async () => {
    const callerHandle = await startWorkflow(caller, {
      args: [endpointName, `twoSync:${calleeWorkflowId}`],
    });
    const callerWorkflowId = callerHandle.workflowId;
    t.is(await callerHandle.result(), `ok:${MODE_SIGNAL_WITH_START}|ok:${MODE_SIGNAL}`);

    const calleeResult = await client.workflow.getHandle(calleeWorkflowId).result();
    t.is(calleeResult, 'first,second');

    const callerHistory = await fetchHistory(client, callerWorkflowId);
    const calleeHistory = await fetchHistory(client, calleeWorkflowId);

    assertForwardLinks(t, calleeHistory, callerWorkflowId, 2);

    const completedEvents = getAllEventsOfType(callerHistory, EventType.EVENT_TYPE_NEXUS_OPERATION_COMPLETED);
    t.is(completedEvents.length, 2, 'expected two NexusOperationCompleted events on the caller');
    // The test server runs with CHASM signal backlinks enabled, so a response link must be present
    // on every NexusOperationCompleted event.
    for (const completed of completedEvents) {
      t.is(assertResponseLink(t, completed), calleeWorkflowId);
    }
  });
});

test('async Nexus operation that signals propagates the response link onto NexusOperationStarted', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint, taskQueue } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();
  const callerWorkflowId = `async-caller-${randomUUID()}`;
  const calleeWorkflowId = `async-callee-${randomUUID()}`;

  const worker = await createWorker({
    nexusServices: [makeSignalingServiceHandler(taskQueue)],
  });

  await worker.runUntil(async () => {
    const callerHandle = await startWorkflow(caller, {
      workflowId: callerWorkflowId,
      args: [endpointName, `${MODE_ASYNC_SIGNAL_WITH_START}:${calleeWorkflowId}`],
    });
    t.is(await callerHandle.result(), 'async-started');

    const calleeResult = await client.workflow.getHandle(calleeWorkflowId).result();
    t.is(calleeResult, 'async-signal');

    const callerHistory = await fetchHistory(client, callerHandle.workflowId);
    const calleeHistory = await fetchHistory(client, calleeWorkflowId);

    assertForwardLinks(t, calleeHistory, callerHandle.workflowId, 1);

    const startedEvents = getAllEventsOfType(callerHistory, EventType.EVENT_TYPE_NEXUS_OPERATION_STARTED);
    t.is(startedEvents.length, 1, 'expected exactly one NexusOperationStarted event for the async op');
    // The test server runs with CHASM signal backlinks enabled, so the response link must be present
    // on the NexusOperationStarted event.
    t.is(assertResponseLink(t, startedEvents[0]), calleeWorkflowId);
  });
});

test('one Nexus operation signaling multiple callees lands a response link per callee', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint, taskQueue } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();
  const callerWorkflowId = `multicaller-${randomUUID()}`;
  const calleeIds = [`multicallee-a-${randomUUID()}`, `multicallee-b-${randomUUID()}`, `multicallee-c-${randomUUID()}`];

  const worker = await createWorker({
    nexusServices: [makeSignalingServiceHandler(taskQueue)],
  });

  await worker.runUntil(async () => {
    const callerHandle = await startWorkflow(caller, {
      workflowId: callerWorkflowId,
      args: [endpointName, `${MODE_MULTI_SIGNAL_WITH_START}:${calleeIds.join(',')}`],
    });
    t.is(await callerHandle.result(), `ok:multi:${calleeIds.join(',')}`);

    for (const calleeId of calleeIds) {
      t.is(await client.workflow.getHandle(calleeId).result(), 'multi-signal');
    }

    const callerHistory = await fetchHistory(client, callerWorkflowId);

    for (const calleeId of calleeIds) {
      const calleeHistory = await fetchHistory(client, calleeId);
      assertForwardLinks(t, calleeHistory, callerWorkflowId, 1);
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

////////////////////////////////////////////////////////////////////////////////////////////////////
// Test utilities

async function fetchHistory(client: any, workflowId: string): Promise<temporal.api.history.v1.IHistory> {
  return await client.workflow.getHandle(workflowId).fetchHistory();
}
