// Run all different kinds of ignored dependency functions to check that the Worker reports when they throw
import { dependencies, ExternalDependencies } from '@temporalio/workflow';

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

const { syncIgnored, asyncIgnored } = dependencies<IgnoredTestDependencies>();

export async function ignoredDependencies(): Promise<number> {
  let i = 0;
  syncIgnored.syncImpl(i++);
  syncIgnored.asyncImpl(i++);
  asyncIgnored.syncImpl(i++);
  asyncIgnored.asyncImpl(i++);
  return i;
}
