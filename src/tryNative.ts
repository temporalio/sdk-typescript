import { promisify } from 'util';
import { Worker } from '../native';

async function run() {
  const worker = new Worker("tasks");
  while (true) {
    const res = await promisify(worker.poll.bind(worker))();
    console.log(res);
  }
}

run().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
