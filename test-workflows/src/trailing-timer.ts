import '@temporal-sdk/workflow';
import { sleep } from './sleep';

export async function main() {
  return await Promise.race([
    sleep(20).then(() => 20),
    sleep(30).then(async () => {
      sleep(1).then(() => console.log('trailing timer triggered after workflow completed'));
      return 30;
    }),
  ]);
}
