import { sleep } from '@temporalio/workflow';

export async function main(): Promise<string> {
  return await Promise.race([
    sleep(1).then(() => 'first'),
    sleep(1).then(() => {
      // This should never be executed
      console.log('trailing timer triggered after workflow completed');
      sleep(0);
      return 'second';
    }),
  ]);
}
