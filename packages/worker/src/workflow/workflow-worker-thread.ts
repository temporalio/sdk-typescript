import { isMainThread, parentPort as parentPortOrNull } from 'node:worker_threads';
import { IllegalStateError } from '@temporalio/common';
import { coresdk } from '@temporalio/proto';
import { Workflow, WorkflowCreator } from './interface';
import { ReusableVMWorkflowCreator } from './reusable-vm';
import { VMWorkflowCreator } from './vm';
import { WorkerThreadRequest } from './workflow-worker-thread/input';
import { WorkerThreadResponse } from './workflow-worker-thread/output';
import { isBun } from './bun';

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
      let activation;
      if (input.activation instanceof Uint8Array) {
        if (isBun) {
          activation = coresdk.workflow_activation.WorkflowActivation.decode(input.activation);
        } else {
          throw new Error('Should not be encoding activations when not using Bun');
        }
      } else {
        activation = input.activation;
      }
      const completion = await workflow.activate(activation);
      const completion2 = isBun
        ? coresdk.workflow_completion.WorkflowActivationCompletion.encode(completion).finish()
        : completion;
      return {
        requestId,
        result: {
          type: 'ok',
          output: {
            type: 'activation-completion',
            completion: completion2,
          },
        },
      };
    }
    case 'extract-sink-calls': {
      const workflow = workflowGetter(input.runId);
      if (workflow === undefined) {
        throw new IllegalStateError(`Tried to activate non running workflow with runId: ${input.runId}`);
      }
      const calls = await workflow.getAndResetSinkCalls();
      calls.forEach((call) => {
        // Delete .now because functions can't be serialized / sent to thread.
        delete (call.workflowInfo.unsafe as any).now;
        // Use structuredClone when available to work around a postMessage bug where
        // shared object references get corrupted during serialization.
        call.workflowInfo =
          'structuredClone' in globalThis
            ? structuredClone(call.workflowInfo)
            : { ...call.workflowInfo, unsafe: { ...call.workflowInfo.unsafe } };
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
 * Transfer a response to the parent thread with zero-copy semantics when possible.
 *
 * For Bun, we use structuredClone with transfer option because Bun's postMessage
 * doesn't properly detach buffers when transferring from worker to main thread.
 * See: https://github.com/oven-sh/bun/issues/18705
 */
function postResponse(response: WorkerThreadResponse): void {
  const completion = response.result.type === 'ok' ? response.result.output : undefined;
  if (isBun && completion?.type === 'activation-completion' && completion.completion instanceof Uint8Array) {
    const buffer = completion.completion.buffer;
    const cloned = structuredClone(response, { transfer: [buffer] });
    parentPort.postMessage(cloned);
  } else {
    parentPort.postMessage(response);
  }
}

/**
 * Listen on messages delivered from the parent thread (the SDK Worker),
 * process any requests and respond back with result or error.
 */
parentPort.on('message', async (request: WorkerThreadRequest) => {
  try {
    postResponse(await handleRequest(request));
  } catch (err: any) {
    parentPort.postMessage({
      requestId: request.requestId,
      result: { type: 'error', message: err.message, name: err.name, stack: err.stack },
    });
  }
});
