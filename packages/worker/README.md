# Worker library for [temporal.io](http://temporal.io)

Main package of the Temporal SDK.
Used to run workflows and activities.

See the root [README](https://github.com/temporalio/sdk-node/blob/main/packages/meta/README.md) for more details.

### Usage

```ts
import { Worker } from '@temporalio/worker';

async function run() => {
  // Automatically locate and register activities and workflows
  // (assuming package was bootstrapped with `npm init @temporalio`).
  // Worker connects to localhost by default and uses console error for logging.
  // Customize the worker by passing options a second parameter to the constructor.
  const worker = new Worker(__dirname);
  // Bind to the `tutorial` queue and start accepting tasks
  await worker.run('tutorial');
}

run().catch((err) => {
  console.error('Error while running worker', err);
  process.exit(1);
});
```
