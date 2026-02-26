import {
  ActivityCancellationType,
  condition,
  defineQuery,
  defineSignal,
  defineUpdate,
  executeChild,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';

// Intentionally duplicated from the test-side converter fixture because workflow isolate code cannot import Node-side modules.
export interface Tracer {
  __tracer: string;
  trace: string[];
}

export interface SerializationContextWorkflowResult {
  startInput: Tracer;
  activityResult: Tracer;
  childResult: Tracer;
  seenQueryInput: Tracer;
  seenUpdateInput: Tracer;
  seenSignalInput: Tracer;
  signalExternalErrorMessage: string;
  cancelExternalErrorMessage: string;
}

export const serializationContextQuery = defineQuery<Tracer, [Tracer]>('serializationContextQuery');
export const serializationContextUpdate = defineUpdate<Tracer, [Tracer]>('serializationContextUpdate');
export const serializationContextFinishSignal = defineSignal<[Tracer]>('serializationContextFinishSignal');

const { echoTracer, completeAsync } = proxyActivities<{
  echoTracer(value: Tracer): Promise<Tracer>;
  completeAsync(): Promise<Tracer>;
}>({
  startToCloseTimeout: '1m',
  scheduleToCloseTimeout: '30m',
  retry: { maximumAttempts: 1 },
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

export async function serializationContextChildWorkflow(input: Tracer): Promise<Tracer> {
  return input;
}

export async function serializationContextWorkflow(
  startInput: Tracer,
  childWorkflowId: string,
  externalSignalWorkflowId: string,
  externalCancelWorkflowId: string
): Promise<SerializationContextWorkflowResult> {
  let seenQueryInput: Tracer | undefined;
  let seenUpdateInput: Tracer | undefined;
  let seenSignalInput: Tracer | undefined;

  setHandler(serializationContextQuery, (input) => {
    seenQueryInput = input;
    return input;
  });
  setHandler(serializationContextUpdate, (input) => {
    seenUpdateInput = input;
    return input;
  });
  setHandler(serializationContextFinishSignal, (input) => {
    seenSignalInput = input;
  });

  const activityResult = await echoTracer({ __tracer: 'activity', trace: [] });
  const childResult = await executeChild(serializationContextChildWorkflow, {
    workflowId: childWorkflowId,
    args: [{ __tracer: 'child', trace: [] }],
  });

  let signalExternalErrorMessage = '';
  try {
    await getExternalWorkflowHandle(externalSignalWorkflowId).signal('serializationContextMissingSignal', {
      __tracer: 'external-signal',
      trace: [],
    });
  } catch (err) {
    signalExternalErrorMessage = (err as Error).message;
  }

  let cancelExternalErrorMessage = '';
  try {
    await getExternalWorkflowHandle(externalCancelWorkflowId).cancel();
  } catch (err) {
    cancelExternalErrorMessage = (err as Error).message;
  }

  await condition(() => seenSignalInput !== undefined);

  return {
    startInput,
    activityResult,
    childResult,
    seenQueryInput: seenQueryInput!,
    seenUpdateInput: seenUpdateInput!,
    seenSignalInput: seenSignalInput!,
    signalExternalErrorMessage,
    cancelExternalErrorMessage,
  };
}

export async function serializationContextAsyncCompletionWorkflow(): Promise<Tracer> {
  return await completeAsync();
}
