import dedent from 'dedent';
import ivm from 'isolated-vm';
import { Scheduler } from '../scheduler';

export async function injectPromise(context: ivm.Context, scheduler: Scheduler) {
  function createPromise(callback: ivm.Reference<Function>) {
    const taskId = scheduler.enqueueEvent({ type: 'TaskCreate' });
    callback.applySync(
      undefined, [
        (valueIsTaskId: boolean, value: unknown) => void scheduler.enqueueEvent({ type: 'PromiseResolve', valueIsTaskId, value, taskId }),
        (error: ivm.Reference<unknown>) => void scheduler.enqueueEvent({ type: 'PromiseReject', error, taskId }),
      ], {
        arguments: { reference: true },
      });
    return taskId;
  }

  function promiseThen(
    taskId: ivm.Reference<number>,
    resolvedCallback: ivm.Reference<Function | undefined>,
    rejectedCallback: ivm.Reference<Function | undefined>,
  ) {
    const nextTaskId = scheduler.enqueueEvent({ type: 'TaskCreate' });

    const wrapCallback = (callback: ivm.Reference) => (value: unknown) => {
      try {
        const [valueIsTaskId, nextValue] = callback.applySync(undefined, [value], { arguments: { copy: true }, result: { copy: true } }) as [boolean, unknown];
        scheduler.enqueueEvent({
          type: 'PromiseResolve',
          taskId: nextTaskId,
          valueIsTaskId,
          value: nextValue,
        });
      } catch (error) {
        scheduler.enqueueEvent({
          type: 'PromiseReject',
          taskId: nextTaskId,
          error,
        });
      }
    }

    if (resolvedCallback.typeof !== 'undefined') {
      scheduler.enqueueEvent({
        type: 'TaskResolvedRegister',
        taskId: taskId.copySync(),
        callback: (_, value) => wrapCallback(resolvedCallback)(value),
      });
    }
    if (rejectedCallback.typeof !== 'undefined') {
      scheduler.enqueueEvent({
        type: 'TaskRejectedRegister',
        taskId: taskId.copySync(),
        // TODO: fix type
        callback: (err: any) => wrapCallback(rejectedCallback)(err.derefInto()),
      });
    }
    return nextTaskId;
  }

  await context.evalClosure(
    dedent`
      globalThis.Promise = function(executor) {
        this.taskId = $0.applySync(
          undefined,
          [
            (resolve, reject) => executor(
              (value) => {
                const isPromise = value instanceof Promise;
                const resolvedValue = isPromise ? value.taskId : value;
                resolve.applySync(undefined, [isPromise, resolvedValue], { arguments: { copy: true } });
              },
              (err) => void reject.applySync(undefined, [err], { arguments: { reference: true } }),
            )
          ],
          {
            arguments: { reference: true },
            result: { copy: true },
          },
        );
      }
      globalThis.Promise.prototype.then = function promiseThen(resolvedCallback, rejectedCallback) {
        const promise = Object.create(null);
        Object.setPrototypeOf(promise, Promise.prototype);
        const wrapCallback = (callback) => (value) => {
          const ret = callback(value);
          const isPromise = ret instanceof Promise;
          const resolvedValue = isPromise ? ret.taskId : ret;
          return [isPromise, resolvedValue];
        }
        promise.taskId = $1.applySync(undefined, [this.taskId, wrapCallback(resolvedCallback), wrapCallback(rejectedCallback)], { arguments: { reference: true } });
        return promise;
      }
      globalThis.Promise.prototype.catch = function promiseCatch(callback) {
        return this.then(undefined, callback);
      }
    `,
    [createPromise, promiseThen], { arguments: { reference: true } });
}
