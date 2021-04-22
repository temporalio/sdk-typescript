// @@@SNIPSTART nodejs-hello-worker
import { Worker } from '@temporalio/worker';

async function run() {
  // Automatically locate and register activities and workflows
  // (assuming package was bootstrapped with `npm init @temporalio`).
  // Worker connects to localhost by default and uses console error for logging.
  // Customize the worker by passing options a second parameter of `create()`.
  const worker = await Worker.create(__dirname, { taskQueue: 'tutorial' });
  // Start accepting tasks on the `tutorial` queue
  await worker.run();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
// @@@SNIPEND
