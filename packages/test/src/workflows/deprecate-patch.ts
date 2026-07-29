import { deprecatePatch, patched } from '@temporalio/workflow';

export async function deprecatePatchWorkflow(): Promise<void> {
  deprecatePatch('my-change-id');
  if (!patched('my-change-id')) {
    throw new Error('Deprecated patch must remain active');
  }
  console.log('has change');
}
