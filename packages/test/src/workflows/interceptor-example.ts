/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Context, WorkflowInterceptors, defaultDataConverter, Headers, sleep, Trigger } from '@temporalio/workflow';
import { echo } from './configured-activities';

class InvalidTimerDurationError extends Error {}

export const interceptorExample = () => {
  const unblocked = new Trigger<void>();

  return {
    signals: {
      unblock(secret: string) {
        if (secret !== '12345') {
          // Workflow execution should fail
          throw new Error('Wrong unblock secret');
        }
        unblocked.resolve();
      },
    },
    queries: {
      getSecret() {
        return '12345';
      },
    },
    async execute(): Promise<string> {
      try {
        await sleep(1);
        throw new Error('timer did not fail');
      } catch (err) {
        if (!(err instanceof InvalidTimerDurationError)) {
          throw new Error('timer failed with wrong error type');
        }
      }
      await sleep(2);
      await unblocked;
      // Untyped because we intercept the result
      const result = await Context.child('successString').execute();
      if (result !== 3) {
        throw new Error('expected interceptor to change child workflow result');
      }
      return await echo(); // Do not pass message in, done in Activity interceptor
    },
  };
};

let receivedMessage = '';

export const interceptors = (): WorkflowInterceptors => ({
  inbound: [
    {
      async execute(input, next) {
        const encoded = input.headers.get('message');
        receivedMessage = encoded ? await defaultDataConverter.fromPayload(encoded) : '';
        return next(input);
      },
      async handleSignal(input, next) {
        const [encoded] = input.args;
        const decoded = [...(encoded as any as string)].reverse().join('');
        return next({ ...input, args: [decoded] });
      },
      async handleQuery(input, next) {
        const secret: string = (await next(input)) as any;
        return [...secret].reverse().join('');
      },
    },
  ],
  outbound: [
    {
      async scheduleActivity(input, next) {
        const headers: Headers = new Map();
        headers.set('message', await defaultDataConverter.toPayload(receivedMessage));
        return next({ ...input, headers });
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
          throw new InvalidTimerDurationError('Expected anything other than 1');
        }
        return next(input);
      },
      async startChildWorkflowExecution(input, next) {
        const [started, completed] = await next(input);
        return [started, completed.then(() => 3)];
      },
    },
  ],
  internals: [],
});
