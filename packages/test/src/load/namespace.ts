import { randomUUID } from 'node:crypto';
import { status } from '@grpc/grpc-js';
import type { Connection } from '@temporalio/client';
import { isGrpcServiceError, NamespaceNotFoundError, WorkflowClient, WorkflowNotFoundError } from '@temporalio/client';
import { msToTs } from '@temporalio/common/time';

export async function waitOnNamespace(
  connection: Connection,
  namespace: string,
  maxAttempts = 100,
  retryIntervalSecs = 1
): Promise<void> {
  // Registration can finish before the history service's namespace cache has caught up.
  // A missing workflow confirms that workflow requests can resolve the namespace.
  const handle = new WorkflowClient({ connection, namespace }).getHandle('namespace-readiness-probe', randomUUID());
  for (let attempt = 1; attempt <= maxAttempts; ++attempt) {
    try {
      await handle.describe();
      return;
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        return;
      }
      if (!(err instanceof NamespaceNotFoundError) || attempt === maxAttempts) {
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
    } catch (err) {
      if (isGrpcServiceError(err) && err.code === status.ALREADY_EXISTS) {
        break;
      }
      if (attempt === maxAttempts) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, retryIntervalSecs * 1000));
    }
  }
}
