import * as nexus from 'nexus-rpc';
import * as workflow from '@temporalio/workflow';

////////////////////////////////////////////////////////////////////////////////////////////////////
// Shared callee Workflow

export const pingSignal = workflow.defineSignal<[string]>('ping');

/**
 * Target Workflow that the Nexus operation handlers signal. It collects `expectedSignals` ping
 * payloads and returns them joined, so each test can assert which signals actually landed.
 */
export async function callee(expectedSignals: number): Promise<string> {
  const received: string[] = [];
  workflow.setHandler(pingSignal, (msg: string) => {
    received.push(msg);
  });
  await workflow.condition(() => received.length >= expectedSignals);
  return received.join(',');
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Test: sync signalWithStart + signal on the same callee

export const twoSyncService = nexus.service('twoSyncSignaling', {
  signalWithStart: nexus.operation<{ workflowId: string }, string>(),
  signal: nexus.operation<{ workflowId: string }, string>(),
});

export async function twoSyncCaller(endpoint: string, calleeWorkflowId: string): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: twoSyncService });
  const signalWithStartResult = await client.executeOperation('signalWithStart', { workflowId: calleeWorkflowId });
  const signalResult = await client.executeOperation('signal', { workflowId: calleeWorkflowId });
  return `${signalWithStartResult}|${signalResult}`;
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Test: async signalWithStart propagates the backlink onto NexusOperationStarted

export const asyncSignalService = nexus.service('asyncSignaling', {
  signalWithStart: nexus.operation<{ workflowId: string }, string>(),
});

export async function asyncCaller(endpoint: string, calleeWorkflowId: string): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: asyncSignalService });
  // startOperation resolves once the operation is Started (the event that carries the backlink for
  // the async path); we intentionally do not await its eventual result.
  await client.startOperation('signalWithStart', { workflowId: calleeWorkflowId });
  return 'async-started';
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Test: one operation signaling multiple callees lands a response link per callee

export const multiSignalService = nexus.service('multiSignaling', {
  signalMany: nexus.operation<{ workflowIds: string[] }, string>(),
});

export async function multiCaller(endpoint: string, calleeWorkflowIds: string[]): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: multiSignalService });
  return await client.executeOperation('signalMany', { workflowIds: calleeWorkflowIds });
}
