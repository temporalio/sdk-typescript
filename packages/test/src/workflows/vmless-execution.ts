import {
  ApplicationFailure,
  CancellationScope,
  condition,
  currentUpdateInfo,
  defineQuery,
  defineSignal,
  defineUpdate,
  patched,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';

export {
  completionConversionFailure,
  emptyRejectionFailure,
  failureConversionFailure,
  ownedHandlerErrors,
  caughtActivityFailure,
  caughtCancellation,
} from './vmless-owned-errors';

const { echo } = proxyActivities<{ echo(value: string): Promise<string> }>({ startToCloseTimeout: '10s' });
let calls = 0;

export async function lifecycle(): Promise<string> {
  let state = 'waiting';
  setHandler(defineQuery<string>('state'), () => state);
  setHandler(defineSignal<[string]>('unblock'), (value) => {
    state = value;
  });
  setHandler(defineUpdate<string, [string]>('change'), async (value) => {
    const id = currentUpdateInfo()!.id;
    const scope = CancellationScope.current();
    await sleep(1);
    if (currentUpdateInfo()!.id !== id || CancellationScope.current() !== scope)
      throw new Error('Lost update ownership');
    state = value;
    return `${workflowInfo().runId}:${id}`;
  });
  console.log('started', ++calls);
  await sleep(1);
  await condition(() => state !== 'waiting');
  const result = await echo(state);
  return `${result}:${calls}:${patched('vmless-patch')}`;
}

export async function immediate(): Promise<string> {
  for (let i = 0; i < 10000; i++) await Promise.resolve();
  return `${workflowInfo().runId}:${++calls}`;
}

export async function manyConditionRounds(): Promise<number> {
  let progress = 0;
  const advance = async (offset: number) => {
    for (let i = 0; i < 1500; i++) {
      await condition(() => progress === 2 * i + offset);
      progress++;
    }
  };
  await Promise.all([advance(0), advance(1)]);
  return progress;
}

export async function globalTimer(): Promise<string> {
  let done = false;
  const handle = setTimeout(() => {
    done = true;
  }, 1);
  setHandler(defineSignal('cancel'), () => {
    clearTimeout(handle);
    done = true;
  });
  await condition(() => done);
  return workflowInfo().runId;
}

export async function applicationFailure(): Promise<void> {
  throw ApplicationFailure.nonRetryable('prototype failure');
}

export async function taskFailure(): Promise<void> {
  throw new Error('prototype task failure');
}

export async function rejectUnobserved(): Promise<void> {
  void Promise.reject(new Error('unobserved'));
  await condition(() => false);
}

export async function caughtDetachedRejection(): Promise<string> {
  void Promise.reject(new Error('handled detached failure')).catch(() => undefined);
  await Promise.resolve();
  return 'handled';
}

export async function catchThrows(): Promise<void> {
  void Promise.reject(new Error('original rejection')).catch(() => {
    throw new Error('catch handler failed');
  });
  await condition(() => false);
}

export async function lateAwait(): Promise<void> {
  const first = sleep(1);
  const second = Promise.reject(new Error('observed too late'));
  await first;
  await second;
}

export async function delayedRejection(): Promise<void> {
  // The disposable-process harness triggers this after activation or disposal,
  // without relying on runtime-specific event-loop timing.
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_, rejectPromise) => {
    reject = rejectPromise;
  });
  (globalThis as typeof globalThis & { __vmlessTestReject?: () => Promise<never> }).__vmlessTestReject = () => {
    reject(new Error('delayed rejection'));
    return promise;
  };
  await condition(() => false);
}

export async function ordering(): Promise<string[]> {
  const order: string[] = [];
  let signalled = false;
  setHandler(defineSignal('go'), () => {
    signalled = true;
    order.push('signal');
    void Promise.resolve().then(() => order.push('signal.then'));
  });
  await Promise.all([
    sleep(1).then(() => order.push('timer')),
    echo('ready').then(() => order.push('activity')),
    condition(() => signalled).then(() => order.push('condition')),
  ]);
  return order;
}

export async function busyLoop(): Promise<void> {
  for (;;) {
    /* Deliberately hangs the disposable test thread. */
  }
}

export async function microtaskLoop(): Promise<void> {
  for (;;) await Promise.resolve();
}
