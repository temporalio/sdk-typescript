import { isMainThread, parentPort as parentPortOrNull } from 'worker_threads';
import { IllegalStateError } from '@temporalio/common';
import { VMWorkflow, VMWorkflowCreator } from './vm';
import { WorkerThreadRequest } from './workflow-worker-thread/input';
import { WorkerThreadResponse } from './workflow-worker-thread/output';
import { coresdk } from '@temporalio/proto';

if (isMainThread) {
  throw new IllegalStateError(`Imported ${__filename} from main thread`);
}

if (parentPortOrNull === null) {
  throw new TypeError(`${__filename} got a null parentPort`);
}

// Create a new parentPort variable that is not nullable to please TS
const parentPort = parentPortOrNull;

function respond(response: WorkerThreadResponse): void {
  return parentPort.postMessage(response);
}

function respondOk(requestId: BigInt): void {
  return respond({ requestId, result: { type: 'ok' } });
}

let workflowCreator: VMWorkflowCreator | undefined;
const workflowByRunId = new Map<string, VMWorkflow>();

parentPort.on('message', async ({ requestId, input }: WorkerThreadRequest) => {
  try {
    switch (input.type) {
      case 'init':
        workflowCreator = await VMWorkflowCreator.create(input.code, input.isolateExecutionTimeoutMs);
        respondOk(requestId);
        return;
      case 'destroy':
        await workflowCreator?.destroy();
        respondOk(requestId);
        return;
      case 'create-workflow': {
        if (workflowCreator === undefined) {
          throw new IllegalStateError('No WorkflowCreator in Worker thread');
        }
        const workflow = (await workflowCreator.createWorkflow(input.options)) as VMWorkflow;
        workflowByRunId.set(input.options.info.runId, workflow);
        respondOk(requestId);
        return;
      }
      case 'activate-workflow': {
        const workflow = workflowByRunId.get(input.runId);
        if (workflow === undefined) {
          throw new IllegalStateError(`Tried to activate non running workflow with runId: ${input.runId}`);
        }
        const activation = coresdk.workflow_activation.WFActivation.decodeDelimited(input.activation);
        const completion = await workflow.activate(activation);
        respond({
          requestId,
          result: { type: 'ok', output: { type: 'activation-completion', completion } },
        });
        return;
      }
      case 'exteract-sink-calls': {
        const workflow = workflowByRunId.get(input.runId);
        if (workflow === undefined) {
          throw new IllegalStateError(`Tried to activate non running workflow with runId: ${input.runId}`);
        }
        const calls = await workflow.getAndResetSinkCalls();
        respond({
          requestId,
          result: { type: 'ok', output: { type: 'sink-calls', calls } },
        });
        return;
      }
      case 'dispose-workflow': {
        const workflow = workflowByRunId.get(input.runId);
        if (workflow === undefined) {
          throw new IllegalStateError(`Tried to dispose non running workflow with runId: ${input.runId}`);
        }
        await workflow.dispose();
        respondOk(requestId);
        return;
      }
    }
  } catch (err: any) {
    respond({
      requestId,
      result: { type: 'error', message: err.message, name: err.name, stack: err.stack },
    });
  }
});
