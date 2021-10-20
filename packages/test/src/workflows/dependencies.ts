import { dependencies, ExternalDependencies } from '@temporalio/workflow';

export interface TestDependencies extends ExternalDependencies {
  success: {
    runAsync(counter: number): void;
    runSync(counter: number): void;
  };
  error: {
    throwAsync(counter: number): void;
    throwSync(counter: number): void;
  };
}

const { success, error } = dependencies<TestDependencies>();

export async function dependenciesWorkflow(): Promise<void> {
  let i = 0;
  success.runSync(i++);
  success.runAsync(i++);
  error.throwSync(i++);
  error.throwAsync(i++);
}
