import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import { TASK_QUEUES, WORKFLOW_TYPE } from './config';

export interface WorkflowResult {
  taskQueue: string;
  result: string;
}

export async function startCustomerWorkflows(client: Client): Promise<WorkflowResult[]> {
  const handles = await Promise.all(
    TASK_QUEUES.map(async (taskQueue) => ({
      taskQueue,
      handle: await client.workflow.start(WORKFLOW_TYPE, {
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      }),
    }))
  );

  return await Promise.all(
    handles.map(async ({ taskQueue, handle }) => ({ taskQueue, result: (await handle.result()) as string }))
  );
}

export async function runStarter(): Promise<void> {
  const { connectionOptions, namespace } = loadClientConnectConfig();
  const connection = await Connection.connect(connectionOptions);

  try {
    const client = new Client({ connection, namespace: namespace ?? 'default' });
    const results = await startCustomerWorkflows(client);
    for (const { taskQueue, result } of results) {
      console.log(`${taskQueue}: ${result}`);
    }
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  runStarter().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
