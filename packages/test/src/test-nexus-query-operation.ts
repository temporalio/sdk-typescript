/**
 * Integration tests for Query-backed Nexus operations
 * ({@link temporalnexus.TemporalNexusClient.getWorkflowHandle} + `handle.query`).
 *
 * A Query resolves immediately and writes nothing to history, so it backs a synchronous operation:
 * there is no operation token, no completion callback, and nothing to cancel.
 *
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
      executable: { type: 'cached-download', version: 'v1.8.3-server-1.32.0-162.0' },
      extraArgs: ['--dynamic-config-value', 'system.refreshNexusEndpointsMinWait="0s"'],
    },
  },
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// Query / service definitions

interface QueryInput {
  workflowId: string;
  runId?: string;
}

export const getCountQuery = workflow.defineQuery<number>('getCount');
export const doneSignal = workflow.defineSignal('done');
export const bumpSignal = workflow.defineSignal('bump');

const queryOpService = nexus.service('counterQueryService', {
  getCount: nexus.operation<QueryInput, number>(),
});

function makeGetCountHandler() {
  return new temporalnexus.TemporalOperationHandler<QueryInput, number>({
    async start(_ctx, client, input) {
      const handle = client.getWorkflowHandle(input.workflowId, input.runId);
      // A Query resolves immediately, so the operation is synchronous.
      return temporalnexus.TemporalOperationResult.sync(await handle.query(getCountQuery));
    },
  });
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Workflows

export async function counterWorkflow(): Promise<number> {
  let counter = 0;
  let done = false;

  workflow.setHandler(getCountQuery, () => counter);
  workflow.setHandler(bumpSignal, () => {
    counter++;
  });
  workflow.setHandler(doneSignal, () => {
    done = true;
  });

  await workflow.condition(() => done);
  return counter;
}

export async function queryCallerWorkflow(endpoint: string, input: QueryInput): Promise<number> {
  const client = workflow.createNexusServiceClient({ endpoint, service: queryOpService });
  // Bounded so a regression that makes a terminal failure retryable surfaces as a timeout rather
  // than hanging the test.
  return await client.executeOperation('getCount', input, { scheduleToCloseTimeout: '20s' });
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
 * Assert that a caller-side event carries a response link naming the queried Workflow. A Query
 * produces no history event, so the server answers with a `Link.Workflow` identifying the execution
 * that processed the Query rather than the `Link.WorkflowEvent` the signal and update paths use.
 */
function assertQueryResponseLink(
  t: any,
  event: temporal.api.history.v1.IHistoryEvent,
  queriedWorkflowId: string
): void {
  t.true((event.links?.length ?? 0) >= 1, `expected a query response link on ${event.eventType}`);
  const link = event.links![0];
  t.truthy(
    link.workflow,
    'a Query link must use the Workflow variant, not WorkflowEvent, because a Query writes nothing to history'
  );
  t.is(link.workflow?.workflowId, queriedWorkflowId, 'the response link should name the queried workflow');
  t.truthy(link.workflow?.runId, 'the response link should name the run that processed the Query');
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Tests

test('query Nexus operation returns the queried result', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();
  const counterWorkflowId = `counter-${randomUUID()}`;

  const worker = await createWorker({
    nexusServices: [nexus.serviceHandler(queryOpService, { getCount: makeGetCountHandler() })],
  });

  await worker.runUntil(async () => {
    const counter = await client.workflow.start(counterWorkflow, {
      workflowId: counterWorkflowId,
      taskQueue: worker.options.taskQueue,
    });
    await counter.signal(bumpSignal);
    await counter.signal(bumpSignal);

    t.is(await executeWorkflow(queryCallerWorkflow, { args: [endpointName, { workflowId: counterWorkflowId }] }), 2);

    await counter.signal(doneSignal);
  });
});

test("query Nexus operation attaches the response link to the caller's NexusOperationCompleted event", async (t) => {
  // End-to-end response link check: the server attaches a link to QueryWorkflowResponse, the client
  // hands it to the Nexus operation context, and the SDK puts it on the caller's
  // NexusOperationCompleted event.
  //
  // Only the response direction is asserted. A Query writes nothing to the queried Workflow's
  // history, so there is no event on the callee side to carry a forward link, unlike signal.
  const { createWorker, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();
  const counterWorkflowId = `counter-${randomUUID()}`;

  const worker = await createWorker({
    nexusServices: [nexus.serviceHandler(queryOpService, { getCount: makeGetCountHandler() })],
  });

  await worker.runUntil(async () => {
    const counter = await client.workflow.start(counterWorkflow, {
      workflowId: counterWorkflowId,
      taskQueue: worker.options.taskQueue,
    });
    await counter.signal(bumpSignal);
    await counter.signal(bumpSignal);

    const callerHandle = await startWorkflow(queryCallerWorkflow, {
      args: [endpointName, { workflowId: counterWorkflowId }],
    });
    t.is(await callerHandle.result(), 2);

    const completedEvents = getAllEventsOfType(
      await callerHandle.fetchHistory(),
      EventType.EVENT_TYPE_NEXUS_OPERATION_COMPLETED
    );
    t.is(completedEvents.length, 1, 'expected exactly one NexusOperationCompleted event');
    assertQueryResponseLink(t, completedEvents[0]!, counterWorkflowId);

    await counter.signal(doneSignal);
  });
});
