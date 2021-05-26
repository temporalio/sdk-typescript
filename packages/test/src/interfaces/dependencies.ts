import { Dependencies } from '@temporalio/workflow';

export interface TestDependencies extends Dependencies {
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

export interface IgnoredTestDependencies extends Dependencies {
  syncIgnored: {
    syncImpl(counter: number): void;
    asyncImpl(counter: number): void;
  };
  asyncIgnored: {
    syncImpl(counter: number): void;
    asyncImpl(counter: number): void;
  };
}

export interface LoggerDependencies extends Dependencies {
  logger: {
    info(message: string): void;
  };
}
