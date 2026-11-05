import { isMainThread, parentPort } from 'node:worker_threads';
import { IllegalStateError } from '@temporalio/common';
import { coresdk } from '@temporalio/proto';
import type { WorkflowInfo } from '@temporalio/workflow';
import { VmlessWorkflowCreator } from './vmless';
import type { WorkerThreadRequest, PatchActivationCallbackRequest } from './workflow-worker-thread/input';
import type { WorkerThreadResponse } from './workflow-worker-thread/output';
import {
  makePatchActivationWorkflowInfoSnapshot,
  PATCH_ACTIVATION_CALLBACK_BUFFER_SIZE,
  waitForPatchActivationCallbackResult,
} from './patch-activation-callback';

if (isMainThread || !parentPort) throw new IllegalStateError('VM-less workflows require a dedicated thread');
const port = parentPort;
let creator: VmlessWorkflowCreator | undefined;

function requestPatchActivation(info: WorkflowInfo, patchId: string): boolean {
  const resultBuffer = new SharedArrayBuffer(PATCH_ACTIVATION_CALLBACK_BUFFER_SIZE);
  const request: PatchActivationCallbackRequest = {
    type: 'patch-activation-callback',
    workflowInfo: makePatchActivationWorkflowInfoSnapshot(info),
    patchId,
    resultBuffer,
  };
  port.postMessage(request);
  return waitForPatchActivationCallbackResult(resultBuffer);
}

async function handleRequest({ requestId, input }: WorkerThreadRequest): Promise<WorkerThreadResponse> {
  if (input.type === 'init') {
    creator = new VmlessWorkflowCreator(
      input.workflowBundle,
      input.registeredActivityNames,
      input.hasPatchActivationCallback ? requestPatchActivation : undefined
    );
    return { requestId, result: { type: 'ok' } };
  }
  if (!creator) throw new IllegalStateError('VM-less workflow creator not initialized');
  if (input.type === 'destroy') {
    await creator.destroy();
  } else if (input.type === 'create-workflow') {
    await creator.createWorkflow(input.options);
  } else {
    const workflow = creator.workflowByRunId.get(input.runId);
    if (!workflow) throw new IllegalStateError(`Workflow not running: ${input.runId}`);
    if (input.type === 'activate-workflow') {
      const activation =
        input.activation instanceof Uint8Array
          ? coresdk.workflow_activation.WorkflowActivation.decode(input.activation)
          : coresdk.workflow_activation.WorkflowActivation.fromObject(input.activation);
      const completion = await workflow.activate(activation);
      return { requestId, result: { type: 'ok', output: { type: 'activation-completion', completion } } };
    }
    if (input.type === 'extract-sink-calls') {
      const calls = await workflow.getAndResetSinkCalls();
      for (const call of calls) {
        call.workflowInfo = { ...call.workflowInfo, unsafe: { ...call.workflowInfo.unsafe } };
        delete (call.workflowInfo.unsafe as any).now;
        delete (call.workflowInfo.unsafe as any).random;
      }
      return { requestId, result: { type: 'ok', output: { type: 'sink-calls', calls } } };
    }
    await workflow.dispose();
  }
  return { requestId, result: { type: 'ok' } };
}

// Each request begins outside workflow context. Different runs may activate
// concurrently; Core/Worker guarantee that a single run has no overlapping tasks.
port.on('message', async (request: WorkerThreadRequest) => {
  try {
    port.postMessage(await handleRequest(request));
  } catch (error: any) {
    port.postMessage({
      requestId: request.requestId,
      result: {
        type: 'error',
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    });
  }
});
