import * as workflow from '@temporalio/workflow';

export async function race(): Promise<void> {
  const p1 = Promise.resolve().then(() => console.log(1));
  const p2 = workflow.sleep(10).then(() => console.log(2));
  const p3 = workflow.sleep(11).then(() => console.log(3));
  await Promise.all([p1, p2, p3]);
}
