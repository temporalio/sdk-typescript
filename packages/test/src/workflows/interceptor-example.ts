import type { WorkflowInterceptors } from '@temporalio/workflow';
import {
  ApplicationFailure,
  condition,
  defaultPayloadConverter,
  defineQuery,
  defineSignal,
  getExternalWorkflowHandle,
  setHandler,
  sleep,
  startChild,
} from '@temporalio/workflow';
import { echo } from './configured-activities';

class InvalidTimerDurationError extends Error {}

export const unblockWithSecretSignal = defineSignal<[string]>('unblock');
export const getSecretQuery = defineQuery<string>('getSecret');

export async function interceptorExample(): Promise<string> {
  let unblocked = false;
  setHandler(unblockWithSecretSignal, (secret: string) => {
    if (secret !== '12345') {
      // Workflow execution should fail
      throw ApplicationFailure.nonRetryable('Wrong unblock secret');
    }
    unblocked = true;
  });
  setHandler(getSecretQuery, () => '12345');

  try {
    await sleep(1);
    throw new Error('timer did not fail');
  } catch (err) {
    if (!(err instanceof InvalidTimerDurationError)) {
      throw ApplicationFailure.nonRetryable('timer failed with wrong error type');
    }
  }
  await sleep(2);
  await condition(() => unblocked);
  const handle = await startChild(interceptedChild);
  await handle.signal(unblockWithSecretSignal, '456');
  await getExternalWorkflowHandle(handle.workflowId).signal(unblockWithSecretSignal, '123');

  const result = await handle.result();
  if (result !== receivedMessage) {
    throw ApplicationFailure.nonRetryable('expected child workflow to return receivedMessage via interceptor');
  }
  return await echo(); // Do not pass message in, done in Activity interceptor
}

/**
 * A workflow that is used to verify child workflow start and signals work
 */
export async function interceptedChild(): Promise<string> {
  let accumulatedSecret = '';
  setHandler(unblockWithSecretSignal, (secret: string) => void (accumulatedSecret += secret));
  // Input is reversed in interceptor
  await condition(() => accumulatedSecret === '654321');
  return receivedMessage;
}

let receivedMessage = '';

export const interceptors = (): WorkflowInterceptors => ({
  inbound: [
    {
      async execute(input, next) {
        const encoded = input.headers.message;
        receivedMessage = encoded ? defaultPayloadConverter.fromPayload(encoded) : '';
        return next(input);
      },
      async handleSignal(input, next) {
        // We get the marker header from client signal
        // We get the marker header (and the message header) from client signalWithStart
        if (!(input.headers.marker && defaultPayloadConverter.fromPayload(input.headers.marker) === true)) {
          throw ApplicationFailure.nonRetryable('Expected signal to have "marker" header');
        }
        const [encoded] = input.args;
        const decoded = [...(encoded as any as string)].reverse().join('');
        return next({ ...input, args: [decoded] });
      },
      async handleQuery(input, next) {
        if (!(input.headers.marker && defaultPayloadConverter.fromPayload(input.headers.marker) === true)) {
          throw ApplicationFailure.nonRetryable('Expected query to have "marker" header');
        }
        const secret: string = (await next(input)) as any;
        return [...secret].reverse().join('');
      },
    },
  ],
  outbound: [
    {
      async scheduleActivity(input, next) {
        return next({
          ...input,
          headers: { ...input.headers, message: defaultPayloadConverter.toPayload(receivedMessage) },
        });
      },
      async startTimer(input, next) {
        if (input.durationMs === 1) {
          throw new InvalidTimerDurationError('Expected anything other than 1');
        }
        return next(input);
      },
      async continueAsNew(input, next) {
        // Used to test interception of continue-as-new-to-different-workflow
        if (input.args[0] === 1) {
          throw ApplicationFailure.nonRetryable('Expected anything other than 1', 'InvalidTimerDurationError');
        }
        return next(input);
      },
      async startChildWorkflowExecution(input, next) {
        return await next({
          ...input,
          headers: { ...input.headers, message: defaultPayloadConverter.toPayload(receivedMessage) },
        });
      },
      async signalWorkflow(input, next) {
        return await next({
          ...input,
          headers: { ...input.headers, marker: defaultPayloadConverter.toPayload(true) },
        });
      },
    },
  ],
  internals: [],
});
