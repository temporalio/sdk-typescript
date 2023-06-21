import { Connection } from '@temporalio/client';
import { msToTs } from '@temporalio/common/lib/time';

// Starting with 1.20, we should no longer need to wait on namespace
// TODO: Remove all of this once we are confident that this is no longer required
export async function waitOnNamespace(
  connection: Connection,
  namespace: string,
  maxAttempts = 100,
  retryIntervalSecs = 1
): Promise<void> {
  const runId = '12345678-dead-beef-1234-1234567890ab';
  for (let attempt = 1; attempt <= maxAttempts; ++attempt) {
    try {
      await connection.workflowService.getWorkflowExecutionHistory({
        namespace,
        execution: { workflowId: 'fake', runId },
      });
    } catch (err: any) {
      if (
        err.details.includes('workflow history not found') ||
        err.details.includes('Workflow executionsRow not found') ||
        err.details.includes('operation GetCurrentExecution') ||
        err.details.includes('operation GetWorkflowExecution encountered not found') ||
        err.details.includes(runId)
      ) {
        break;
      }
      if (attempt === maxAttempts) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, retryIntervalSecs * 1000));
    }
  }
}

export async function createNamespace(
  connection: Connection,
  namespace: string,
  maxAttempts = 100,
  retryIntervalSecs = 1
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; ++attempt) {
    try {
      await connection.workflowService.registerNamespace({
        namespace,
        workflowExecutionRetentionPeriod: msToTs('1 day'),
      });
      break;
    } catch (err: any) {
      if (err.details === 'Namespace already exists.') {
        break;
      }
      if (attempt === maxAttempts) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, retryIntervalSecs * 1000));
    }
  }
}
