/**
 * Integration tests for UpdateWorkflow-backed Nexus operations
 * ({@link WorkflowHandle.update}).
 *
 *
 * Operations are driven through a caller workflow (as in the Go suite) so the Nexus machinery
 * supplies a completion callback URL, which UpdateWorkflow operations require.
 *
 * NOTE: requires an ephemeral Temporal server (started via makeTestFunction) with Nexus and CHASM
 * callbacks enabled, same as test-nexus-temporal-operation.ts.
 */
import { randomUUID } from 'crypto';
import * as nexus from 'nexus-rpc';
import type { Duration } from '@temporalio/common';
import * as temporalnexus from '@temporalio/nexus';
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
      // The default dev server (Temporal 1.31.2) does not deliver Workflow Update completion
      // callbacks to Nexus. Pin a server build that does (server 1.32.0-157.0).
      executable: { type: 'cached-download', version: 'v1.7.2-standalone-nexus-operations' },
      extraArgs: [
        '--dynamic-config-value',
        'system.refreshNexusEndpointsMinWait="0s"',
        '--dynamic-config-value',
        'history.enableChasmCallbacks=true',
        '--dynamic-config-value',
        'history.enableUpdateCallbacks=true',
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
      return await client.getWorkflowHandle(input.workflowId).update<UpdateAddOutput, [number, number]>(addUpdateName, {
        updateId: input.updateId,
        args: [input.amount, input.sleepMs ?? 0],
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
      // A positive sleepMs makes the handler suspend on a timer after being accepted, so the Update
      // is "accepted but not yet completed" when the server returns the ACCEPTED response — the
      // condition that routes the Nexus operation down the async completion-callback path. Any
      // positive duration works (the timer guarantees suspension into a later workflow task); with
      // sleepMs 0 the handler completes in the acceptance task and the operation resolves
      // synchronously instead.
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

export async function callerWorkflow(
  endpoint: string,
  input: UpdateAddInput,
  // Optional bound on the Nexus operation. Used by the completed-workflow test to cap an operation
  // whose start would otherwise retry forever (see that test for details).
  operationOptions?: { scheduleToCloseTimeout?: Duration }
): Promise<UpdateAddOutput> {
  const client = workflow.createNexusServiceClient({ endpoint, service: updateOpService });
  return await client.executeOperation('addOperation', input, operationOptions);
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
// the pinned test server (server 1.32.0-157.0) provides with history.enableUpdateCallbacks=true.
test('UpdateWorkflow Nexus operation - pending update completes asynchronously via callback', async (t) => {
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
    // sleepMs > 0 forces the Update handler to suspend after acceptance (see counterWorkflow), which
    // deterministically drives the async completion-callback path exercised by this test.
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

// Updating a completed workflow does not succeed. Whether the backing Update fails fast (vs. retries
// forever) depends on the server classifying the "workflow already completed" error as
// non-retryable. Both the default dev server (Temporal 1.31.2) and the pinned build
// (server 1.32.0-157.0) still return NOT_FOUND (WorkflowNotFoundError) and treat it as RETRYABLE, so
// the Nexus operation start is retried indefinitely and, without a bound, the caller never resolves.
test('UpdateWorkflow Nexus operation - update against a completed workflow does not succeed', async (t) => {
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

    // The backing Update start retries forever against the completed workflow, so bound the operation
    // with a scheduleToCloseTimeout; the operation must error (not succeed) within that window.
    const err = await t.throwsAsync(() =>
      executeWorkflow(callerWorkflow, {
        args: [endpointName, { workflowId: counterWorkflowId, amount: 5 }, { scheduleToCloseTimeout: '5s' }],
      })
    );
    t.truthy(err);
  });
});
