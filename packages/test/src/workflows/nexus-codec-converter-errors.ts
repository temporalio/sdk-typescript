import * as nexus from 'nexus-rpc';
import * as workflow from '@temporalio/workflow';

export const testService = nexus.service('codec-converter-test', {
  echoOp: nexus.operation<string, string>(),
});

export async function nexusEchoCaller(endpoint: string): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: testService });
  const handle = await client.startOperation('echoOp', 'hello');
  return await handle.result();
}
