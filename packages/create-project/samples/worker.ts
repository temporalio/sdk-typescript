// @@@SNIPSTART nodejs-hello-worker
import { Worker } from '@temporalio/worker';

async function run() {
  // Automatically locate and register activities and workflows
  // (assuming package was bootstrapped with `npm init @temporalio`).
  // Worker connects to localhost by default and uses console error for logging.
  // Customize the worker by passing options a second parameter of `create()`.
  const worker = await Worker.create(__dirname);
  // Bind to the `tutorial` queue and start accepting tasks
  await worker.run('tutorial');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
// @@@SNIPEND
