import * as nexus from 'nexus-rpc';
import type { Duration } from '@temporalio/common';
import * as workflow from '@temporalio/workflow';

////////////////////////////////////////////////////////////////////////////////////////////////////
// Update / service definitions

export interface UpdateAddInput {
  workflowId: string;
  updateId?: string;
  amount: number;
  sleepMs?: number;
}

export interface UpdateAddOutput {
  count: number;
}

export const addUpdateName = 'addUpdate';

export const addUpdate = workflow.defineUpdate<UpdateAddOutput, [number, number]>(addUpdateName);

export const doneSignal = workflow.defineSignal('done');

export const updateOpService = nexus.service('counterUpdateService', {
  addOperation: nexus.operation<UpdateAddInput, UpdateAddOutput>(),
});

/**
 * Operation that starts a Workflow run and then tries to also back itself with an Update. Only one
 * async backing operation is allowed per handler invocation, and the Workflow run has already
 * consumed it, so the Update must be rejected.
 */
export const runThenUpdateService = nexus.service('runThenUpdateService', {
  startThenUpdate: nexus.operation<{ workflowId: string }, number>(),
});

export async function runThenUpdateCaller(endpoint: string, counterWorkflowId: string): Promise<number> {
  const client = workflow.createNexusServiceClient({ endpoint, service: runThenUpdateService });
  return await client.executeOperation(
    'startThenUpdate',
    { workflowId: counterWorkflowId },
    { scheduleToCloseTimeout: '10s' }
  );
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
