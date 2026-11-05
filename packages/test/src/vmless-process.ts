import { readFileSync } from 'node:fs';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { setTimeout as hostTimeout } from 'node:timers/promises';
import { coresdk } from '@temporalio/proto';
import { VmlessWorkflowCreator, type WorkflowCreateOptions } from '@temporalio/worker/internal/vmless';

async function main(): Promise<void> {
  if (isMainThread) {
    const worker = new Worker(__filename, { workerData: JSON.parse(readFileSync(0, 'utf8')) });
    worker.on('message', (message) => process.stdout.write(`${JSON.stringify(message)}\n`));
    // No error listener: fatal workflow-thread errors must fail this child process.
    return;
  }
  const { bundle, scenario, options } = workerData;
  const creator = new VmlessWorkflowCreator(bundle, new Set());
  if (scenario === 'unowned') {
    void Promise.reject(new Error('unowned rejection'));
    return;
  }
  const name = scenario === 'disposed' || scenario === 'late-detached' ? 'delayedRejection' : scenario;
  const opts: WorkflowCreateOptions = { ...options, info: { ...options.info, workflowType: name } };
  const workflow = await creator.createWorkflow(opts);
  parentPort!.postMessage('ACTIVATING');
  const activation = (jobs: coresdk.workflow_activation.IWorkflowActivationJob[]) =>
    workflow.activate(
      coresdk.workflow_activation.WorkflowActivation.fromObject({
        timestamp: { seconds: 1 },
        jobs,
      })
    );
  const completion = await activation([
    { initializeWorkflow: { workflowType: name, workflowId: 'test', originalExecutionRunId: opts.info.runId } },
  ]);
  if (scenario === 'mappedFailure') {
    parentPort!.postMessage(completion);
    await workflow.dispose();
    await creator.destroy();
  } else if (scenario === 'disposed') {
    await workflow.dispose();
    parentPort!.postMessage('DISPOSED');
    (globalThis as typeof globalThis & { __vmlessTestReject: () => void }).__vmlessTestReject();
    await hostTimeout(100);
  } else if (scenario === 'late-detached') {
    parentPort!.postMessage('BETWEEN_ACTIVATIONS');
    (globalThis as typeof globalThis & { __vmlessTestReject: () => void }).__vmlessTestReject();
    await hostTimeout(100);
  }
}

void main();
