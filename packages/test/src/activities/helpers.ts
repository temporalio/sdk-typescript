import type { WorkflowHandle } from '@temporalio/client';
import type { QueryDefinition } from '@temporalio/common';
import { Context } from '@temporalio/activity';

function getSchedulingWorkflowHandle(): WorkflowHandle {
  const { info, client } = Context.current();
  const { workflowExecution } = info;
  return client.workflow.getHandle(workflowExecution.workflowId, workflowExecution.runId);
}

export async function signalSchedulingWorkflow(signalName: string): Promise<void> {
  const handle = getSchedulingWorkflowHandle();
  await handle.signal(signalName);
}

export async function queryOwnWf<R, A extends any[]>(queryDef: QueryDefinition<R, A>, ...args: A): Promise<R> {
  const handle = getSchedulingWorkflowHandle();
  return await handle.query(queryDef, ...args);
}
