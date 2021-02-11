import '@temporal-sdk/workflow';
import { sleep } from './sleep';

export async function main() {
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
