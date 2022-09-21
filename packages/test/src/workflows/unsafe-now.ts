import { workflowInfo } from '@temporalio/workflow';

export async function unsafeNow(): Promise<number> {
  const start = workflowInfo().unsafe.now();
  for (let i = 0; i < 100000000; i++) {
    // empty
  }
  const end = workflowInfo().unsafe.now();
  return end - start;
}
