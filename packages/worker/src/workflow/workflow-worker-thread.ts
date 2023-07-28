import { isMainThread, parentPort as parentPortOrNull } from 'node:worker_threads';
import { IllegalStateError } from '@temporalio/common';
import { Workflow, WorkflowCreator } from './interface';
import { ReusableVMWorkflowCreator } from './reusable-vm';
import { VMWorkflowCreator } from './vm';
import { WorkerThreadRequest } from './workflow-worker-thread/input';
import { WorkerThreadResponse } from './workflow-worker-thread/output';

if (isMainThread) {
  throw new IllegalStateError(`Imported ${__filename} from main thread`);
}

if (parentPortOrNull === null) {
  throw new TypeError(`${__filename} got a null parentPort`);
}

// Create a new parentPort variable that is not nullable to please TS
const parentPort = parentPortOrNull;

function ok(requestId: bigint): WorkerThreadResponse {
  return { requestId, result: { type: 'ok' } };
}

let workflowCreator: WorkflowCreator | undefined;
let workflowGetter: (runId: string) => Workflow | undefined;

/**
 * Process a `WorkerThreadRequest` and resolve with a `WorkerThreadResponse`.
 */
async function handleRequest({ requestId, input }: WorkerThreadRequest): Promise<WorkerThreadResponse> {
  switch (input.type) {
    case 'init':
      if (input.reuseV8Context) {
        workflowCreator = await ReusableVMWorkflowCreator.create(
          input.workflowBundle,
          input.isolateExecutionTimeoutMs,
          input.registeredActivityNames
        );
        workflowGetter = (runId) => ReusableVMWorkflowCreator.workflowByRunId.get(runId);
      } else {
        workflowCreator = await VMWorkflowCreator.create(
          input.workflowBundle,
          input.isolateExecutionTimeoutMs,
          input.registeredActivityNames
        );
        workflowGetter = (runId) => VMWorkflowCreator.workflowByRunId.get(runId);
      }
      return ok(requestId);
    case 'destroy':
      await workflowCreator?.destroy();
      return ok(requestId);
    case 'create-workflow': {
      if (workflowCreator === undefined) {
        throw new IllegalStateError('No WorkflowCreator in Worker thread');
      }
      await workflowCreator.createWorkflow(input.options);
      return ok(requestId);
    }
    case 'activate-workflow': {
      const workflow = workflowGetter(input.runId);
      if (workflow === undefined) {
        throw new IllegalStateError(`Tried to activate non running workflow with runId: ${input.runId}`);
      }
      const completion = await workflow.activate(input.activation);
      return {
        requestId,
        result: { type: 'ok', output: { type: 'activation-completion', completion } },
      };
    }
    case 'extract-sink-calls': {
      const workflow = workflowGetter(input.runId);
      if (workflow === undefined) {
        throw new IllegalStateError(`Tried to activate non running workflow with runId: ${input.runId}`);
      }
      const calls = await workflow.getAndResetSinkCalls();
      calls.map((call) => {
        // Delete .now because functions can't be serialized / sent to thread.
        // Do this on a copy of the object, as workflowInfo is the live object.
        call.workflowInfo = {
          ...call.workflowInfo,
          unsafe: { ...call.workflowInfo.unsafe },
        };
        delete (call.workflowInfo.unsafe as any).now;
      });

      return {
        requestId,
        result: { type: 'ok', output: { type: 'sink-calls', calls } },
      };
    }
    case 'dispose-workflow': {
      const workflow = workflowGetter(input.runId);
      if (workflow === undefined) {
        throw new IllegalStateError(`Tried to dispose non running workflow with runId: ${input.runId}`);
      }
      await workflow.dispose();
      return ok(requestId);
    }
  }
}

/**
 * Listen on messages delivered from the parent thread (the SDK Worker),
 * process any requests and respond back with result or error.
 */
parentPort.on('message', async (request: WorkerThreadRequest) => {
  try {
    parentPort.postMessage(await handleRequest(request));
  } catch (err: any) {
    parentPort.postMessage({
      requestId: request.requestId,
      result: { type: 'error', message: err.message, name: err.name, stack: err.stack },
    });
  }
});
