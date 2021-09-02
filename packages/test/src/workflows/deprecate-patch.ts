import { deprecatePatch } from '@temporalio/workflow';
import { Empty } from '../interfaces';

async function execute(): Promise<void> {
  deprecatePatch('my-change-id');
  console.log('has change');
}

export const deprecatePatchWorkflow: Empty = () => ({ execute });
