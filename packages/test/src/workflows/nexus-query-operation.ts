import * as nexus from 'nexus-rpc';
import * as workflow from '@temporalio/workflow';

export interface QueryInput {
  workflowId: string;
  runId?: string;
}

export const getCountQuery = workflow.defineQuery<number>('getCount');
export const doneSignal = workflow.defineSignal('done');
export const bumpSignal = workflow.defineSignal('bump');

export const queryOpService = nexus.service('counterQueryService', {
  getCount: nexus.operation<QueryInput, number>(),
});

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
  return await client.executeOperation('getCount', input, { scheduleToCloseTimeout: '20s' });
}
