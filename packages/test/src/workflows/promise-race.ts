import { Workflow, sleep } from '@temporalio/workflow';

async function execute(): Promise<void> {
  console.log(await Promise.race([1, 2, 3]));
  console.log(await Promise.race(new Set([1, 2, 3]).values()));
  console.log(await Promise.race([1, 2, 3].map((v) => Promise.resolve(v))));
  console.log(await Promise.race([1, Promise.reject(new Error('wow'))]));
  console.log(await Promise.race([sleep(20).then(() => 20), sleep(30).then(() => 30)]));
  try {
    await Promise.race([Promise.reject(new Error('wow')), 1, 2]);
  } catch (err: any) {
    console.log(err.message);
  }
}

export const workflow: Workflow = { execute };
