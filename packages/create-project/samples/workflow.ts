import { sleep } from '@temporalio/workflow';
import { Example } from '@interfaces/workflows';

async function main(name: string): Promise<string> {
  // TODO: use activity instead
  await sleep(1000);
  return `Hello, ${name}!`;
}

export const workflow: Example = { main };
