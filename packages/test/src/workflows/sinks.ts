import type { Sinks } from '@temporalio/workflow';
import { proxySinks } from '@temporalio/workflow';

export interface TestSinks extends Sinks {
  success: {
    runAsync(counter: number): void;
    runSync(counter: number): void;
  };
  error: {
    throwAsync(counter: number): void;
    throwSync(counter: number): void;
  };
}

const { success, error } = proxySinks<TestSinks>();

export async function sinksWorkflow(): Promise<void> {
  let i = 0;
  success.runSync(i++);
  success.runAsync(i++);
  error.throwSync(i++);
  error.throwAsync(i++);
}
