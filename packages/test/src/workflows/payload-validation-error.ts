import {
  ApplicationFailure,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  defineUpdate,
  executeChild,
  getExternalWorkflowHandle,
  proxyActivities,
  proxyLocalActivities,
  setHandler,
  sleep,
  startChild,
  upsertMemo,
} from '@temporalio/workflow';

const invalidSignal = defineSignal<[unknown]>('invalidSignal');
const validSignal = defineSignal('validSignal');
const invalidQuery = defineQuery<unknown, [unknown]>('invalidQuery');
const invalidUpdate = defineUpdate<unknown, [unknown]>('invalidUpdate');
const captureSignal = defineSignal<[unknown]>('captureSignal');
const { payloadValidationActivity } = proxyActivities<{ payloadValidationActivity(input: unknown): Promise<any> }>({
  startToCloseTimeout: '10s',
  retry: { maximumAttempts: 3 },
});
const { payloadValidationActivity: payloadValidationLocalActivity } = proxyLocalActivities<{
  payloadValidationActivity(input: unknown): Promise<any>;
}>({
  startToCloseTimeout: '10s',
  retry: { maximumAttempts: 3 },
});
const { payloadValidationActivity: payloadValidationEagerActivity } = proxyActivities<{
  payloadValidationActivity(input: unknown): Promise<any>;
}>({
  startToCloseTimeout: '10s',
  retry: { maximumAttempts: 3 },
  allowEagerDispatch: true,
});

export async function payloadValidationInputWorkflow(_input: unknown): Promise<string> {
  return 'handler invoked';
}

export async function payloadValidationHeaderWorkflow(input?: unknown): Promise<unknown> {
  return input;
}

export async function payloadValidationChildInputWorkflow(id: string, marker = 'decode'): Promise<string> {
  return await executeChild(payloadValidationInputWorkflow, { args: [{ __payloadValidation: marker, id }] });
}

export async function payloadValidationHandlerFailureWorkflow(retryable: boolean): Promise<never> {
  if (retryable) {
    throw ApplicationFailure.retryable('ordinary handler failure', 'PayloadValidationError');
  }
  throw ApplicationFailure.nonRetryable('Payload validation failed', 'PayloadValidationError');
}

export async function payloadValidationMessageWorkflow(): Promise<string> {
  let done = false;
  setHandler(invalidSignal, () => {
    throw new Error('invalid signal handler was invoked');
  });
  setHandler(validSignal, () => {
    done = true;
  });
  setHandler(invalidQuery, (value) => value);
  setHandler(invalidUpdate, (value) => value);
  await condition(() => done);
  return 'done';
}

export async function payloadValidationOutputWorkflow(id: string, marker = 'codec-encode-once'): Promise<unknown> {
  return { __payloadValidation: marker, id };
}

export async function payloadValidationContinueAsNewWorkflow(input: {
  id: string;
  continued?: boolean;
  marker?: string;
}): Promise<string> {
  if (input.continued) return 'continued';
  return await continueAsNew<typeof payloadValidationContinueAsNewWorkflow>({
    __payloadValidation: input.marker ?? 'codec-encode-once',
    id: input.id,
    continued: true,
    marker: input.marker,
  } as any);
}

export async function payloadValidationActivityInputWorkflow(input: { activityInput: unknown }): Promise<unknown> {
  return await payloadValidationActivity(input.activityInput);
}

export async function payloadValidationLocalActivityInputWorkflow(input: { activityInput: unknown }): Promise<unknown> {
  return await payloadValidationLocalActivity(input.activityInput);
}

export async function payloadValidationEagerActivityInputWorkflow(input: { activityInput: unknown }): Promise<unknown> {
  return await payloadValidationEagerActivity(input.activityInput);
}

export async function payloadValidationActivityOutputWorkflow(id: string): Promise<number> {
  const result = await payloadValidationActivity({ id });
  return result.attempt;
}

export async function payloadValidationLocalActivityOutputWorkflow(id: string): Promise<number> {
  const result = await payloadValidationLocalActivity({ id });
  return result.attempt;
}

export async function payloadValidationEagerActivityOutputWorkflow(id: string): Promise<number> {
  const result = await payloadValidationEagerActivity({ id });
  return result.attempt;
}

export async function payloadValidationSignalTargetWorkflow(): Promise<unknown> {
  let result: unknown;
  setHandler(captureSignal, (value) => {
    result = value;
  });
  await condition(() => result !== undefined);
  return result;
}

export async function payloadValidationOutboundWorkflow(
  kind: 'activity' | 'local-activity' | 'child' | 'signal' | 'child-signal' | 'memo' | 'user-metadata' | 'header',
  id: string,
  targetWorkflowId?: string,
  marker = 'codec-encode-once'
): Promise<string> {
  const value = { __payloadValidation: marker, id };
  switch (kind) {
    case 'activity':
      await payloadValidationActivity(value);
      break;
    case 'local-activity':
      await payloadValidationLocalActivity(value);
      break;
    case 'child':
      await executeChild(payloadValidationInputWorkflow, { args: [value] });
      break;
    case 'signal':
      await getExternalWorkflowHandle(targetWorkflowId!).signal(captureSignal, value);
      break;
    case 'child-signal': {
      const child = await startChild(payloadValidationSignalTargetWorkflow);
      await child.signal(captureSignal, value);
      await child.result();
      break;
    }
    case 'memo':
      upsertMemo({ invalid: value });
      break;
    case 'user-metadata':
      await sleep(1, { summary: `${marker}:${id}` });
      break;
    case 'header':
      await payloadValidationActivity({ __payloadValidationHeader: true, id, marker });
      break;
  }
  return 'done';
}
