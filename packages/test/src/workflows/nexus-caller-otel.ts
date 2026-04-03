import * as nexus from 'nexus-rpc';
import * as workflow from '@temporalio/workflow';

export const otelNexusService = nexus.service('otel-test-service', {
  syncOp: nexus.operation<string, string>({ name: 'my-sync-op' }),
});

export async function otelNexusCaller(
  endpoint: string,
  op: keyof typeof otelNexusService.operations,
  input: string
): Promise<string> {
  const client = workflow.createNexusClient({
    endpoint,
    service: otelNexusService,
  });
  return await client.executeOperation(op, input);
}
