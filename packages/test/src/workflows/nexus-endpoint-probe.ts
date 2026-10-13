import * as nexus from 'nexus-rpc';
import * as workflow from '@temporalio/workflow';

export const nexusEndpointProbeService = nexus.service('nexus-endpoint-probe', {
  echo: nexus.operation<string, string>(),
});

/** Call the probe service's echo operation through `endpoint`. Used to check that an endpoint is routable. */
export async function nexusEndpointProbeCaller(endpoint: string, input: string): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: nexusEndpointProbeService });
  return await client.executeOperation('echo', input, { scheduleToCloseTimeout: '10s' });
}
