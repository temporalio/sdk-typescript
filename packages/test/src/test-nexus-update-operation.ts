/**
 * Integration tests for UpdateWorkflow-backed Nexus operations
 * ({@link TemporalNexusClient.updateWorkflow}).
 *
 * These mirror the acceptance criteria of the Go SDK's TestNexusUpdateWorkflowOperation suite:
 * validation failures surface as failed operations, valid updates succeed, updates sharing an
 * Update ID are idempotent, and updates against a completed workflow fail.
 *
 * Operations are driven through a caller workflow (as in the Go suite) so the Nexus machinery
 * supplies a completion callback URL, which UpdateWorkflow operations require.
 *
 * NOTE: requires an ephemeral Temporal server (started via makeTestFunction) with Nexus and CHASM
 * callbacks enabled, same as test-nexus-temporal-operation.ts.
 */
import { randomUUID } from 'crypto';
import * as nexus from 'nexus-rpc';
import * as temporalnexus from '@temporalio/nexus';
import { WorkflowUpdateStage } from '@temporalio/client';
import * as workflow from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';

/** Collect the messages down an error's `cause` chain, so we can assert on a nested failure. */
function causeChainMessages(err: unknown): string {
  const messages: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    messages.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return messages.join(' | ');
}

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowEnvironmentOpts: {
    server: {
      extraArgs: [
        '--dynamic-config-value',
        'system.refreshNexusEndpointsMinWait="0s"',
        '--dynamic-config-value',
        'history.enableChasmCallbacks=true',
      ],
    },
  },
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// Update / service definitions

interface UpdateAddInput {
  workflowId: string;
  updateId?: string;
  amount: number;
  sleepMs?: number;
}

interface UpdateAddOutput {
  count: number;
}

const addUpdateName = 'addUpdate';
export const addUpdate = workflow.defineUpdate<UpdateAddOutput, [number, number]>(addUpdateName);
export const doneSignal = workflow.defineSignal('done');

const updateOpService = nexus.service('counterUpdateService', {
  addOperation: nexus.operation<UpdateAddInput, UpdateAddOutput>(),
});

function makeAddOperationHandler() {
  return new temporalnexus.TemporalOperationHandler<UpdateAddInput, UpdateAddOutput>({
    async start(_ctx, client, input) {
      return await client.updateWorkflow<UpdateAddOutput, [number, number]>({
        workflowId: input.workflowId,
        update: addUpdateName,
        updateId: input.updateId,
        args: [input.amount, input.sleepMs ?? 0],
        waitForStage: WorkflowUpdateStage.ACCEPTED,
      });
    },
  });
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Workflows

export async function counterWorkflow(): Promise<number> {
  let counter = 0;
  let done = false;

  workflow.setHandler(
    addUpdate,
    async (amount: number, sleepMs: number): Promise<UpdateAddOutput> => {
      counter += amount;
      const snapshot = counter;
      if (sleepMs > 0) {
        await workflow.sleep(sleepMs);
      }
      return { count: snapshot };
    },
    {
      validator: (amount: number, _sleepMs: number) => {
        if (amount % 5 !== 0) {
          throw new Error('invalid increment');
        }
      },
    }
  );

  workflow.setHandler(doneSignal, () => {
    done = true;
  });

  await workflow.condition(() => done);
  return counter;
}

export async function callerWorkflow(endpoint: string, input: UpdateAddInput): Promise<UpdateAddOutput> {
  const client = workflow.createNexusServiceClient({ endpoint, service: updateOpService });
  return await client.executeOperation('addOperation', input);
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Tests

test('UpdateWorkflow Nexus operation - valid update succeeds and returns the update result', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();
  const counterWorkflowId = 'counter-' + randomUUID();

  const worker = await createWorker({
    nexusServices: [nexus.serviceHandler(updateOpService, { addOperation: makeAddOperationHandler() })],
  });

  await worker.runUntil(async () => {
    await client.workflow.start(counterWorkflow, {
      workflowId: counterWorkflowId,
      taskQueue: worker.options.taskQueue,
    });
    // sleepMs 0 -> the update completes before it is even reported as accepted, so the operation
    // returns a synchronous result (no completion callback needed).
    const result = await executeWorkflow(callerWorkflow, {
      args: [endpointName, { workflowId: counterWorkflowId, amount: 5, updateId: 'basic-success' }],
    });
    t.is(result.count, 5);
  });
});

// An Update that has not yet completed when it is accepted returns asynchronously; its result is
// delivered to the caller via the Nexus completion callback attached to the Update request. This
// requires server-side support for delivering Workflow Update completion callbacks to Nexus, which
// the bundled ephemeral server (Temporal 1.31.2) does not yet provide (workflow-run completion
// callbacks do work there). Enable once the test server delivers Update completion callbacks.
test.skip('UpdateWorkflow Nexus operation - pending update completes asynchronously via callback', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();
  const counterWorkflowId = 'counter-' + randomUUID();

  const worker = await createWorker({
    nexusServices: [nexus.serviceHandler(updateOpService, { addOperation: makeAddOperationHandler() })],
  });

  await worker.runUntil(async () => {
    await client.workflow.start(counterWorkflow, {
      workflowId: counterWorkflowId,
      taskQueue: worker.options.taskQueue,
    });
    const result = await executeWorkflow(callerWorkflow, {
      args: [endpointName, { workflowId: counterWorkflowId, amount: 5, updateId: 'async-success', sleepMs: 500 }],
    });
    t.is(result.count, 5);
  });
});

test('UpdateWorkflow Nexus operation - validation failure surfaces as a failed operation', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();
  const counterWorkflowId = 'counter-' + randomUUID();

  const worker = await createWorker({
    nexusServices: [nexus.serviceHandler(updateOpService, { addOperation: makeAddOperationHandler() })],
  });

  await worker.runUntil(async () => {
    await client.workflow.start(counterWorkflow, {
      workflowId: counterWorkflowId,
      taskQueue: worker.options.taskQueue,
    });
    const err = await t.throwsAsync(() =>
      executeWorkflow(callerWorkflow, {
        // amount 6 is not a multiple of 5 -> the update validator rejects it.
        args: [endpointName, { workflowId: counterWorkflowId, amount: 6 }],
      })
    );
    // The validation rejection propagates as a failed operation (not a retry-forever); the
    // "invalid increment" message appears nested in the caller workflow failure's cause chain.
    t.regex(causeChainMessages(err), /invalid increment/);
  });
});

test('UpdateWorkflow Nexus operation - non-ACCEPTED waitForStage surfaces as a failed operation', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();
  const counterWorkflowId = 'counter-' + randomUUID();

  // Only ACCEPTED is supported for async Nexus Update operations; requesting COMPLETED is a
  // non-retryable misconfiguration that must surface as a failed operation rather than retry forever.
  const badWaitStageHandler = new temporalnexus.TemporalOperationHandler<UpdateAddInput, UpdateAddOutput>({
    async start(_ctx, client, input) {
      return await client.updateWorkflow<UpdateAddOutput, [number, number]>({
        workflowId: input.workflowId,
        update: addUpdateName,
        updateId: input.updateId,
        args: [input.amount, input.sleepMs ?? 0],
        waitForStage: WorkflowUpdateStage.COMPLETED,
      });
    },
  });

  const worker = await createWorker({
    nexusServices: [nexus.serviceHandler(updateOpService, { addOperation: badWaitStageHandler })],
  });

  await worker.runUntil(async () => {
    await client.workflow.start(counterWorkflow, {
      workflowId: counterWorkflowId,
      taskQueue: worker.options.taskQueue,
    });
    const err = await t.throwsAsync(() =>
      executeWorkflow(callerWorkflow, {
        args: [endpointName, { workflowId: counterWorkflowId, amount: 5 }],
      })
    );
    t.regex(causeChainMessages(err), /ACCEPTED wait stage/);
  });
});

test('UpdateWorkflow Nexus operation - same Update ID is idempotent', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();
  const counterWorkflowId = 'counter-' + randomUUID();

  const worker = await createWorker({
    nexusServices: [nexus.serviceHandler(updateOpService, { addOperation: makeAddOperationHandler() })],
  });

  await worker.runUntil(async () => {
    await client.workflow.start(counterWorkflow, {
      workflowId: counterWorkflowId,
      taskQueue: worker.options.taskQueue,
    });
    const updateId = 'idempotent-' + randomUUID();

    const first = await executeWorkflow(callerWorkflow, {
      args: [endpointName, { workflowId: counterWorkflowId, amount: 5, updateId }],
    });
    t.is(first.count, 5);

    // Re-issuing with the same Update ID must not increment the counter again.
    const second = await executeWorkflow(callerWorkflow, {
      args: [endpointName, { workflowId: counterWorkflowId, amount: 5, updateId }],
    });
    t.is(second.count, 5);
  });
});

// Updating a completed workflow should surface as a failed operation. Whether it fails (vs. retries
// forever) depends on the server classifying the "workflow already completed" error as
// non-retryable for the backing Update; the bundled ephemeral server (Temporal 1.31.2) retries it,
// so the caller operation never resolves here. Enable once that error is non-retryable.
test.skip('UpdateWorkflow Nexus operation - update against a completed workflow fails', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();
  const counterWorkflowId = 'counter-' + randomUUID();

  const worker = await createWorker({
    nexusServices: [nexus.serviceHandler(updateOpService, { addOperation: makeAddOperationHandler() })],
  });

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(counterWorkflow, {
      workflowId: counterWorkflowId,
      taskQueue: worker.options.taskQueue,
    });
    await handle.signal(doneSignal);
    await handle.result();

    const err = await t.throwsAsync(() =>
      executeWorkflow(callerWorkflow, {
        args: [endpointName, { workflowId: counterWorkflowId, amount: 5 }],
      })
    );
    t.truthy(err);
  });
});
