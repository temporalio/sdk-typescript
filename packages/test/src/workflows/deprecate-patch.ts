import { deprecatePatch } from '@temporalio/workflow';

export async function main(): Promise<void> {
  deprecatePatch('my-change-id');
  console.log('has change');
}
