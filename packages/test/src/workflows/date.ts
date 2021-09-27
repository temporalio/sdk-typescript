import '@temporalio/workflow';
import { Empty } from '../interfaces';

async function execute(): Promise<void> {
  console.log(new Date().getTime());
  console.log(Date.now());
  console.log(new Date() instanceof Date);
  console.log(new Date(0) instanceof Date);
  console.log(new Date(0).toJSON() === '1970-01-01T00:00:00.000Z');
  console.log(Date.UTC(1970, 0) === 0);
  console.log(Date.parse('1970-01-01') === 0);
}

export const date: Empty = () => ({ execute });
