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

function ok(requestId: BigInt): WorkerThreadResponse {
  return { requestId, result: { type: 'ok' } };
}

let workflowCreator: VMWorkflowCreator | undefined;
const workflowByRunId = new Map<string, VMWorkflow>();

// Best effort to catch unhandled rejections from workflow code.
// We crash the thread if we cannot find the culprit.
process.on('unhandledRejection', (err, promise) => {
  // Get the runId associated with the vm context.
  // See for reference https://github.com/patriksimek/vm2/issues/32
  const ctor = promise.constructor.constructor;
  const runId = ctor('return globalThis.__TEMPORAL__?.runId')();
  if (runId !== undefined) {
    const workflow = workflowByRunId.get(runId);
    if (workflow !== undefined) {
      workflow.setUnhandledRejection(err);
      return;
    }
  }
  // The user's logger is not accessible in this thread,
  // dump the error information to stderr and abort.
  console.error('Unhandled rejection', { runId }, err);
  process.exit(1);
});

/**
 * Process a `WorkerThreadRequest` and resolve with a `WorkerThreadResponse`.
 */
async function handleRequest({ requestId, input }: WorkerThreadRequest): Promise<WorkerThreadResponse> {
  switch (input.type) {
    case 'init':
      workflowCreator = await VMWorkflowCreator.create(input.code, input.isolateExecutionTimeoutMs);
      return ok(requestId);
    case 'destroy':
      await workflowCreator?.destroy();
      return ok(requestId);
    case 'create-workflow': {
      if (workflowCreator === undefined) {
        throw new IllegalStateError('No WorkflowCreator in Worker thread');
      }
      const workflow = (await workflowCreator.createWorkflow(input.options)) as VMWorkflow;
      workflowByRunId.set(input.options.info.runId, workflow);
      return ok(requestId);
    }
    case 'activate-workflow': {
      const workflow = workflowByRunId.get(input.runId);
      if (workflow === undefined) {
        throw new IllegalStateError(`Tried to activate non running workflow with runId: ${input.runId}`);
      }
      const activation = coresdk.workflow_activation.WorkflowActivation.decodeDelimited(input.activation);
      const completion = await workflow.activate(activation);
      return {
        requestId,
        result: { type: 'ok', output: { type: 'activation-completion', completion } },
      };
    }
    case 'exteract-sink-calls': {
      const workflow = workflowByRunId.get(input.runId);
      if (workflow === undefined) {
        throw new IllegalStateError(`Tried to activate non running workflow with runId: ${input.runId}`);
      }
      const calls = await workflow.getAndResetSinkCalls();
      return {
        requestId,
        result: { type: 'ok', output: { type: 'sink-calls', calls } },
      };
    }
    case 'dispose-workflow': {
      const workflow = workflowByRunId.get(input.runId);
      if (workflow === undefined) {
        throw new IllegalStateError(`Tried to dispose non running workflow with runId: ${input.runId}`);
      }
      workflowByRunId.delete(input.runId);
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
