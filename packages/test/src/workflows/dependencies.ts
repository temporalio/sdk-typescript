import { dependencies, ExternalDependencies } from '@temporalio/workflow';

export interface TestDependencies extends ExternalDependencies {
  syncVoid: {
    promise(counter: number): void;
    ignoredAsyncImpl(counter: number): void;
    sync(counter: number): void;
    ignoredSyncImpl(counter: number): void;
  };
  asyncIgnored: {
    syncImpl(counter: number): void;
    asyncImpl(counter: number): void;
  };
  sync: {
    syncImpl(counter: number): number;
    asyncImpl(counter: number): number;
  };
  async: {
    syncImpl(counter: number): Promise<number>;
    asyncImpl(counter: number): Promise<number>;
  };
  error: {
    throwAsync(counter: number): Promise<never>;
    throwSync(counter: number): number;
    throwSyncPromise(counter: number): number;
  };
}
const { syncVoid, asyncIgnored, sync, async, error } = dependencies<TestDependencies>();

function convertErrorToIntResult(fn: (x: number) => any, x: number): number {
  try {
    return fn(x);
  } catch (err: any) {
    return parseInt(err.message);
  }
}

export async function dependenciesWorkflow(): Promise<number> {
  let i = 0;
  syncVoid.promise(i++);
  syncVoid.ignoredAsyncImpl(i++);
  syncVoid.sync(i++);
  syncVoid.ignoredSyncImpl(i++);

  asyncIgnored.syncImpl(i++);
  asyncIgnored.asyncImpl(i++);

  i = sync.syncImpl(i);
  i = sync.asyncImpl(i);
  i = await async.syncImpl(i);
  i = await async.asyncImpl(i);
  i = await error.throwAsync(i).catch((err) => parseInt(err.message));
  i = convertErrorToIntResult(error.throwSync, i);
  i = convertErrorToIntResult(error.throwSyncPromise, i);
  return i;
}
