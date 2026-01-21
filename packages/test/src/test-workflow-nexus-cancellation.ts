import assert from 'assert';
import { randomUUID } from 'crypto';
import { ExecutionContext } from 'ava';
import * as nexus from 'nexus-rpc';
import { ApplicationFailure, NexusOperationFailure } from '@temporalio/common';
import { WorkflowFailedError, WorkflowHandle } from '@temporalio/client';
import { History } from '@temporalio/common/lib/proto-utils';
import * as temporalnexus from '@temporalio/nexus';
import * as workflow from '@temporalio/workflow';
import { Context, helpers, makeTestFunction } from './helpers-integration';
import { waitUntil } from './helpers';

const test = makeTestFunction({ workflowsPath: __filename });

////////////////////////////////////////////////////////////////////////////////////////////////////
// WORKFLOW's SCHEDULE NEXUS OPERATION's CANCELLATION TYPES
//
// These tests confirm the proper behavior of the various cancellation types that can be specified
// when scheduling a Nexus operation from a Workflow.
//
// All of those tests are based on the following setup:
//
//     CallerWorkflow -> NexusOperation -> TargetWorkflow
//
// 1. CallerWorkflow schedules a Nexus operation with a configurable cancellation type.
// 2. Once CallerWorkflow's history show a NexusOperationStartedEvent, the test function
//    sends a cancellation request to CallerWorkflow.
// 3. Depending on the test scenario, the Nexus Operation Handler will either let the cancellation
//    request propagate down to TargetWorkflow, or the handler will fail the operation immediately.
// 4. If the cancellation request reaches TargetWorkflow, the workflow may (depending on the test
//    scenario) either hang forever, sleep for a short time before rethrowing the cancellation, or
//    immediately rethrow the cancellation.

type CancelTypeTestScenario = {
  operationName: 'startWorkflow' | 'startWorkflowFailCancel';
  cancellationType: workflow.NexusOperationCancellationType;
  targetCancellationBehavior: 'hang' | 'delay' | 'rethrow';
};

export async function cancellationTestCallerWorkflow(
  endpoint: string,
  scenario: CancelTypeTestScenario
): Promise<void> {
  const { cancellationType, operationName: nexusOperationName } = scenario;
  try {
    const client = workflow.createNexusClient({ endpoint, service });
    await client.executeOperation(nexusOperationName, scenario, { cancellationType });
    throw ApplicationFailure.nonRetryable('Unexpected Success');
  } catch (err) {
    if (workflow.isCancellation(err)) return;
    throw err;
  }
}

const service = nexus.service('cancellation-test-service', {
  startWorkflow: nexus.operation<CancelTypeTestScenario, void>(),
  startWorkflowFailCancel: nexus.operation<CancelTypeTestScenario, void>(),
} as const);

function makeNexusServiceHandler() {
  const startWorkflow = new temporalnexus.WorkflowRunOperationHandler<CancelTypeTestScenario, void>(
    async (ctx, scenario) => {
      return await temporalnexus.startWorkflow(ctx, cancellationTestTargetWorkflow, {
        workflowId: randomUUID(),
        args: [scenario],
      });
    }
  );

  return nexus.serviceHandler(service, {
    startWorkflow,
    startWorkflowFailCancel: {
      start: startWorkflow.start.bind(startWorkflow),
      cancel: async (_ctx, _token): Promise<void> => {
        throw new nexus.HandlerError('NOT_IMPLEMENTED', 'Intentional failure');
      },
      // FIXME: Update nexus-rpc dependency, then remove these two methods
      getInfo: startWorkflow.getInfo.bind(startWorkflow),
      getResult: startWorkflow.getResult.bind(startWorkflow),
    },
  });
}

export async function cancellationTestTargetWorkflow(scenario: CancelTypeTestScenario): Promise<void> {
  try {
    await workflow.condition(() => false); // Block forever
    throw workflow.ApplicationFailure.nonRetryable('Unreachable code');
  } catch (err) {
    switch (scenario.targetCancellationBehavior) {
      case 'hang': // Completely ignore the cancellation request, blocking forever
        await workflow.CancellationScope.nonCancellable(async () => {
          await workflow.condition(() => false);
        });
        break;
      case 'delay': // Sleep for a short time before rethrowing
        await workflow.CancellationScope.nonCancellable(async () => {
          await workflow.sleep(100);
        });
        throw err;
      case 'rethrow':
      default:
        throw err;
    }
  }
}

async function testWorkflowNexusCancellation(
  t: ExecutionContext<Context>,
  scenario: CancelTypeTestScenario
): Promise<{ targetHandle: WorkflowHandle<workflow.Workflow>; callerHistory: History }> {
  const { createWorker, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    nexusServices: [makeNexusServiceHandler()],
  });

  const callerHandle = await worker.runUntil(async () => {
    const callerHandle = await startWorkflow(cancellationTestCallerWorkflow, {
      args: [endpointName, scenario],
    });

    // Wait for Nexus Operation to actually get started...
    await waitUntil(
      async () => !!(await callerHandle.fetchHistory()).events?.some((ev) => ev.nexusOperationStartedEventAttributes),
      4000
    );

    // ...and then cancel the caller workflow
    await callerHandle.cancel();

    // Wait for everything to settle down
    await callerHandle.result();

    return callerHandle;
  });

  const callerHistory = await callerHandle.fetchHistory();

  // Get a workflow handle to the target workflow, through the link on the Nexus operation started event
  const nexusOperationStartedEvent = callerHistory.events!.find((ev) => ev.nexusOperationStartedEventAttributes)!;
  const targetWorkflowLinks = nexusOperationStartedEvent.links;
  assert(targetWorkflowLinks?.length === 1);
  const targetWorkflowId = targetWorkflowLinks[0].workflowEvent?.workflowId;
  assert(targetWorkflowId);
  const targetHandle = t.context.env.client.workflow.getHandle(targetWorkflowId);

  return { targetHandle, callerHistory };
}

test('Workflow calling Nexus operation with cancellation type WAIT_CANCELLATION_COMPLETED properly cancels', async (t) => {
  const { targetHandle, callerHistory } = await testWorkflowNexusCancellation(t, {
    cancellationType: 'WAIT_CANCELLATION_COMPLETED',
    operationName: 'startWorkflow',
    targetCancellationBehavior: 'delay',
  });

  // Check caller workflow got Nexus cancel request and cancel completed
  t.is(callerHistory.events?.filter((e) => e.nexusOperationCancelRequestedEventAttributes).length, 1);
  t.is(callerHistory.events?.filter((e) => e.nexusOperationCancelRequestCompletedEventAttributes).length, 1);

  // Confirm target got cancel requested, completed a timer, and is canceled
  t.is((await targetHandle.describe()).status.name, 'CANCELLED');
  t.is((await targetHandle.fetchHistory()).events?.filter((e) => e.timerFiredEventAttributes).length, 1);
});

test("Workflow calling Nexus operation with cancellation type WAIT_CANCELLATION_REQUESTED doesn't wait for completion", async (t) => {
  const { targetHandle, callerHistory } = await testWorkflowNexusCancellation(t, {
    cancellationType: 'WAIT_CANCELLATION_REQUESTED',
    operationName: 'startWorkflow',
    targetCancellationBehavior: 'hang',
  });

  // Check caller workflow got Nexus cancel request and cancel completed
  t.is(callerHistory.events?.filter((e) => e.nexusOperationCancelRequestedEventAttributes).length, 1);
  t.is(callerHistory.events?.filter((e) => e.nexusOperationCancelRequestCompletedEventAttributes).length, 1);

  // Confirm target got cancellation request, but is still running
  const targetDesc = await targetHandle.describe();
  t.is(targetDesc.status.name, 'RUNNING');
  t.true(targetDesc.raw.workflowExtendedInfo?.cancelRequested);
});

test('Workflow calling Nexus operation with cancellation type WAIT_CANCELLATION_REQUESTED properly fails', async (t) => {
  const err = await t.throwsAsync(() =>
    testWorkflowNexusCancellation(t, {
      cancellationType: 'WAIT_CANCELLATION_REQUESTED',
      operationName: 'startWorkflowFailCancel',
      targetCancellationBehavior: 'rethrow', // Won't even get there
    })
  );

  assert(err instanceof WorkflowFailedError);
  assert(err.cause instanceof NexusOperationFailure);
  assert(err.cause.cause instanceof nexus.HandlerError);
  assert(err.cause.cause.type, 'NOT_IMPLEMENTED');
  assert(err.cause.cause.cause instanceof ApplicationFailure);
  t.is(err.cause.cause.cause.message, 'Intentional failure');
});

test('Workflow calling Nexus operation with cancellation type TRY_CANCEL properly cancels', async (t) => {
  const { targetHandle, callerHistory } = await testWorkflowNexusCancellation(t, {
    cancellationType: 'TRY_CANCEL',
    operationName: 'startWorkflowFailCancel',
    targetCancellationBehavior: 'rethrow', // Shouldn't even get there
  });

  // Check caller workflow made a Nexus cancel request, but didn't receive a cancel completed
  t.is(callerHistory.events?.filter((e) => e.nexusOperationCancelRequestedEventAttributes).length, 1);
  t.is(callerHistory.events?.filter((e) => e.nexusOperationCancelRequestCompletedEventAttributes).length, 0);

  // Confirm target never got cancel requested and is still running
  t.is((await targetHandle.describe()).status.name, 'RUNNING');
  t.false((await targetHandle.describe()).raw.workflowExtendedInfo?.cancelRequested);
});

test('Workflow calling Nexus operation with cancellation type ABANDON properly cancels', async (t) => {
  const { targetHandle, callerHistory } = await testWorkflowNexusCancellation(t, {
    cancellationType: 'ABANDON',
    operationName: 'startWorkflow', // Shouldn't reach this point
    targetCancellationBehavior: 'rethrow',
  });

  // Check caller workflow got cancel request but sent no Nexus cancel request
  t.is(callerHistory.events?.filter((e) => e.workflowExecutionCancelRequestedEventAttributes).length, 1);
  t.is(callerHistory.events?.filter((e) => e.nexusOperationCancelRequestedEventAttributes).length, 0);

  // Confirm target never got cancel requested and is still running
  t.is((await targetHandle.describe()).status.name, 'RUNNING');
  t.false((await targetHandle.describe()).raw.workflowExtendedInfo?.cancelRequested);
});
