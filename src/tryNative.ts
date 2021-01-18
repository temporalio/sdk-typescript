import { promisify } from 'util';
import { Worker } from '../native';

async function run() {
  console.log("before init");
  const worker = new Worker("tasks");
  const res = await promisify(worker.poll)();
  console.log(res);
}

run().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
