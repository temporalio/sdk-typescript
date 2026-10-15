import { status } from '@grpc/grpc-js';
import type { Connection } from '@temporalio/client';
import { isGrpcServiceError } from '@temporalio/client';
import { msToTs } from '@temporalio/common/time';

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
