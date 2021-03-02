import { Worker } from '@temporalio/worker';

async function run() {
  // Automatically locate and register activities and workflows
  const worker = new Worker(__dirname);
  // Bind to the `tutorial` queue and start accepting tasks
  await worker.run('tutorial');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
