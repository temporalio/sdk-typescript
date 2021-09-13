import '@temporalio/workflow';
import { Empty } from '../interfaces';

async function execute(): Promise<void> {
  console.log(new Date().getTime());
  console.log(Date.now());
  console.log(new Date() instanceof Date);
}

export const date: Empty = () => ({ execute });
