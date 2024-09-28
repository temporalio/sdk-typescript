import { OpenTelemetryWorkflowClientCallsInterceptor } from '@temporalio/interceptors-opentelemetry';
import { Client, WorkflowHandle } from '@temporalio/client';
import { QueryDefinition } from '@temporalio/common';
import { getContext } from './interceptors';

function getSchedulingWorkflowHandle(): WorkflowHandle {
  const { info, connection, dataConverter } = getContext();
  const { workflowExecution } = info;
  const client = new Client({
    connection,
    namespace: info.workflowNamespace,
    dataConverter,
    interceptors: {
      workflow: [new OpenTelemetryWorkflowClientCallsInterceptor()],
    },
  });
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
