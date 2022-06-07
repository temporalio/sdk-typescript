import { sleep } from '@temporalio/workflow';

export async function trailingTimer(): Promise<string> {
  return await Promise.race([
    sleep(1).then(() => 'first'),
    sleep(1).then(() => {
      // This generates a command that will **not** be executed
      void sleep(0);
      return 'second';
    }),
  ]);
}
