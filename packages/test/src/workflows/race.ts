import { Workflow } from '@temporalio/workflow';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const p1 = Promise.resolve().then(() => console.log(1));
  const p2 = sleep(10).then(() => console.log(2));
  const p3 = sleep(11).then(() => console.log(3));
  await Promise.all([p1, p2, p3]);
}

export const workflow: Workflow = { main };
