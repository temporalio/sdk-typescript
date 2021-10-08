import { deprecatePatch } from '@temporalio/workflow';

export async function deprecatePatchWorkflow(): Promise<void> {
  deprecatePatch('my-change-id');
  console.log('has change');
}
