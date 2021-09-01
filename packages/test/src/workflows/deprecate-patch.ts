import { deprecatePatch } from '@temporalio/workflow';

export async function execute(): Promise<void> {
  deprecatePatch('my-change-id');
  console.log('has change');
}
