import { Worker as NodeWorker } from 'node:worker_threads';
import { ThreadedVMWorkflowCreator, WorkerThreadClient } from './threaded-vm';
import type { ThreadedVMWorkflowCreatorOptions } from './threaded-vm';
import type { WorkflowCreator } from './interface';

/** Reuse the existing thread transport without changing the VM thread bootstrap. */
export async function createThreadedVmlessWorkflowCreator({
  workflowBundle,
  registeredActivityNames,
  logger,
  patchActivationCallback,
}: Pick<
  ThreadedVMWorkflowCreatorOptions,
  'workflowBundle' | 'registeredActivityNames' | 'logger' | 'patchActivationCallback'
>): Promise<WorkflowCreator> {
  const thread = new NodeWorker(require.resolve('./vmless-worker-thread'));
  const client = new WorkerThreadClient(thread, logger, patchActivationCallback);
  try {
    await client.send({
      type: 'init',
      workflowBundle,
      registeredActivityNames,
      hasPatchActivationCallback: patchActivationCallback !== undefined,
      // The transport protocol retains these VM fields; this bootstrap ignores them.
      reuseV8Context: true,
      isolateExecutionTimeoutMs: 0,
    });
  } catch (error) {
    await thread.terminate();
    throw error;
  }
  const transport = new ThreadedVMWorkflowCreator([client]);
  return {
    createWorkflow: (options) => transport.createWorkflow(options),
    async destroy() {
      try {
        await transport.destroy();
      } finally {
        // A failing runtime destructor must not leave the thread alive after a
        // destroy response rejects. Do not change the existing VM transport.
        await thread.terminate();
      }
    },
  };
}
