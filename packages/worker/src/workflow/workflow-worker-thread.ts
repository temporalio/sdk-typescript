import { isMainThread, parentPort as parentPortOrNull } from 'node:worker_threads';
import * as v8 from 'node:v8';
import { IllegalStateError } from '@temporalio/common';
import { coresdk } from '@temporalio/proto';
import type { WorkflowInfo } from '@temporalio/workflow';
import type { Workflow, WorkflowCreator } from './interface';
import { ReusableVMWorkflowCreator } from './reusable-vm';
import { VMWorkflowCreator } from './vm';
import type { PatchActivationCallbackRequest, WorkerThreadRequest } from './workflow-worker-thread/input';
import type { WorkerThreadResponse, WorkflowEvictionNotification } from './workflow-worker-thread/output';
import { isBun, isBunPre1_4 } from './bun';
import {
  makePatchActivationWorkflowInfoSnapshot,
  PATCH_ACTIVATION_CALLBACK_BUFFER_SIZE,
  waitForPatchActivationCallbackResult,
} from './patch-activation-callback';
import { getWorkflowHeapEvictionBatchSize } from './workflow-thread-heap-policy';
import { WorkflowThreadDisposalError } from './threaded-vm-errors';

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
let heapSizeLimit = 0;
const idleWorkflows = new Map<string, undefined>();
const locallyEvictedWorkflows = new Set<string>();

function locallyEvicted(requestId: bigint): WorkerThreadResponse {
  return { requestId, result: { type: 'ok', output: { type: 'workflow-locally-evicted' } } };
}

/**
 * Discard a bounded LRU batch when the thread is under heap pressure.
 *
 * Dereferencing a Workflow does not synchronously reduce V8's used-heap counter, so attempting to loop until the
 * low watermark would often discard the entire cache. Instead, each safe point removes the proportion of idle
 * Workflows needed to move from the observed usage toward the low watermark. Subsequent safe points remeasure.
 */
async function evictWorkflowsUnderHeapPressure(): Promise<void> {
  if (idleWorkflows.size === 0) return;

  const { used_heap_size: usedHeapSize, heap_size_limit: v8HeapSizeLimit } = v8.getHeapStatistics();
  const effectiveHeapSizeLimit = heapSizeLimit || v8HeapSizeLimit;
  const evictionCount = getWorkflowHeapEvictionBatchSize(usedHeapSize, effectiveHeapSizeLimit, idleWorkflows.size);
  if (evictionCount === 0) return;
  const runIds = Array.from(idleWorkflows.keys()).slice(0, evictionCount);

  for (const runId of runIds) {
    idleWorkflows.delete(runId);
    locallyEvictedWorkflows.add(runId);
    try {
      await workflowGetter(runId)?.dispose();
    } catch (cause) {
      // A failed dispose can leave the Workflow strongly referenced by the VM implementation. Discard the whole
      // isolate so the parent can recreate it and request Core eviction for every Workflow the thread owned.
      throw new WorkflowThreadDisposalError(`Failed to dispose Workflow ${runId} under heap pressure`, cause);
    }
  }

  const notification: WorkflowEvictionNotification = {
    type: 'workflow-evictions',
    runIds,
    usedHeapSize,
    heapSizeLimit: effectiveHeapSizeLimit,
  };
  parentPort.postMessage(notification);
}

function requestPatchActivation(workflowInfo: WorkflowInfo, patchId: string): boolean {
  const resultBuffer = new SharedArrayBuffer(PATCH_ACTIVATION_CALLBACK_BUFFER_SIZE);
  const request: PatchActivationCallbackRequest = {
    type: 'patch-activation-callback',
    workflowInfo: makePatchActivationWorkflowInfoSnapshot(workflowInfo),
    patchId,
    resultBuffer,
  };
  parentPort.postMessage(request);
  return waitForPatchActivationCallbackResult(resultBuffer);
}

/**
 * Process a `WorkerThreadRequest` and resolve with a `WorkerThreadResponse`.
 */
async function handleRequest({ requestId, input }: WorkerThreadRequest): Promise<WorkerThreadResponse> {
  switch (input.type) {
    case 'init':
      heapSizeLimit = input.heapSizeLimitBytes ?? v8.getHeapStatistics().heap_size_limit;
      if (input.reuseV8Context) {
        workflowCreator = await ReusableVMWorkflowCreator.create(
          input.workflowBundle,
          input.isolateExecutionTimeoutMs,
          input.registeredActivityNames,
          input.hasPatchActivationCallback ? requestPatchActivation : undefined
        );
        workflowGetter = (runId) => ReusableVMWorkflowCreator.workflowByRunId.get(runId);
      } else {
        workflowCreator = await VMWorkflowCreator.create(
          input.workflowBundle,
          input.isolateExecutionTimeoutMs,
          input.registeredActivityNames,
          input.hasPatchActivationCallback ? requestPatchActivation : undefined
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
      if (locallyEvictedWorkflows.has(input.options.info.runId)) {
        throw new IllegalStateError(
          `Tried to recreate locally evicted workflow with runId: ${input.options.info.runId}`
        );
      }
      await evictWorkflowsUnderHeapPressure();
      await workflowCreator.createWorkflow(input.options);
      return ok(requestId);
    }
    case 'activate-workflow': {
      idleWorkflows.delete(input.runId);
      if (locallyEvictedWorkflows.has(input.runId)) return locallyEvicted(requestId);
      const workflow = workflowGetter(input.runId);
      if (workflow === undefined) {
        throw new IllegalStateError(`Tried to activate non running workflow with runId: ${input.runId}`);
      }
      let activation;
      if (input.activation instanceof Uint8Array) {
        // Before Bun 1.4.0, some activation messages get silently dropped by Bun's postMessage.
        // To work around this bug, we encode activations
        activation = coresdk.workflow_activation.WorkflowActivation.decode(input.activation);
      } else {
        activation = coresdk.workflow_activation.WorkflowActivation.fromObject(input.activation);
      }
      const completion = await workflow.activate(activation);
      const maybeEncodedCompletion = isBunPre1_4
        ? coresdk.workflow_completion.WorkflowActivationCompletion.encode(completion).finish()
        : completion;
      return {
        requestId,
        result: {
          type: 'ok',
          output: {
            type: 'activation-completion',
            completion: maybeEncodedCompletion,
          },
        },
      };
    }
    case 'extract-sink-calls': {
      if (locallyEvictedWorkflows.has(input.runId)) return locallyEvicted(requestId);
      const workflow = workflowGetter(input.runId);
      if (workflow === undefined) {
        throw new IllegalStateError(`Tried to activate non running workflow with runId: ${input.runId}`);
      }
      const calls = await workflow.getAndResetSinkCalls();
      calls.forEach((call) => {
        // Copy before stripping to avoid altering the running Workflow.
        call.workflowInfo = { ...call.workflowInfo, unsafe: { ...call.workflowInfo.unsafe } };
        // Delete .now and .random because functions can't be serialized / sent to thread.
        delete (call.workflowInfo.unsafe as any).now;
        delete (call.workflowInfo.unsafe as any).random;
        // Use structuredClone when available to work around a bug in Bun's postMessage
        // where shared object references get corrupted during serialization.
        if ('structuredClone' in globalThis) {
          call.workflowInfo = structuredClone(call.workflowInfo);
        }
      });

      return {
        requestId,
        result: { type: 'ok', output: { type: 'sink-calls', calls } },
      };
    }
    case 'dispose-workflow': {
      idleWorkflows.delete(input.runId);
      if (locallyEvictedWorkflows.delete(input.runId)) return ok(requestId);
      const workflow = workflowGetter(input.runId);
      if (workflow === undefined) {
        throw new IllegalStateError(`Tried to dispose non running workflow with runId: ${input.runId}`);
      }
      try {
        await workflow.dispose();
      } catch (cause) {
        throw new WorkflowThreadDisposalError(`Failed to dispose Workflow ${input.runId} during Core eviction`, cause);
      }
      return ok(requestId);
    }
    case 'mark-workflow-idle': {
      if (locallyEvictedWorkflows.has(input.runId) || workflowGetter(input.runId) === undefined) {
        return ok(requestId);
      }
      // Reinsertion updates Map iteration order, giving us a compact LRU queue.
      idleWorkflows.delete(input.runId);
      idleWorkflows.set(input.runId, undefined);
      await evictWorkflowsUnderHeapPressure();
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
