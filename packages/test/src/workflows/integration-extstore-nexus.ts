import * as nexus from 'nexus-rpc';
import * as workflow from '@temporalio/workflow';

export const nexusSizeService = nexus.service('extstoreNexusSizeService', {
  sizeOp: nexus.operation<Uint8Array, number>(),
  bigResultOp: nexus.operation<number, Uint8Array>(),
});

export async function extstoreNexusSizeCaller(endpoint: string, sizeBytes: number): Promise<number> {
  const client = workflow.createNexusServiceClient({ endpoint, service: nexusSizeService });
  return await client.executeOperation('sizeOp', new Uint8Array(sizeBytes));
}

export async function extstoreNexusBigResultCaller(endpoint: string, sizeBytes: number): Promise<number> {
  const client = workflow.createNexusServiceClient({ endpoint, service: nexusSizeService });
  const result = await client.executeOperation('bigResultOp', sizeBytes);
  return result.length;
}
