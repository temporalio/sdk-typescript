import * as nexus from 'nexus-rpc';
import * as workflow from '@temporalio/workflow';

export const otelNexusService = nexus.service('otel-test-service', {
  asyncOp: nexus.operation<string, string>({ name: 'my-async-op' }),
});

export async function otelNexusCancelCaller(
  endpoint: string,
  op: keyof typeof otelNexusService.operations,
  input: string
): Promise<string> {
  const client = workflow.createNexusServiceClient({
    endpoint,
    service: otelNexusService,
  });
  try {
    return await workflow.CancellationScope.cancellable(async () => {
      const handle = await client.startOperation(op, input, {
        cancellationType: 'WAIT_CANCELLATION_REQUESTED',
      });
      workflow.CancellationScope.current().cancel();
      return await handle.result();
    });
  } catch (err) {
    if (workflow.isCancellation(err)) {
      return 'cancelled';
    }
    throw err;
  }
}
