import { ExternalDependencies } from '@temporalio/workflow';

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

export interface IgnoredTestDependencies extends ExternalDependencies {
  syncIgnored: {
    syncImpl(counter: number): void;
    asyncImpl(counter: number): void;
  };
  asyncIgnored: {
    syncImpl(counter: number): void;
    asyncImpl(counter: number): void;
  };
}

// @@@SNIPSTART nodejs-external-dependencies-logger-interface
export interface LoggerDependencies extends ExternalDependencies {
  logger: {
    info(message: string): void;
  };
}
// @@@SNIPEND
