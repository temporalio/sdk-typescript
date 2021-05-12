// @@@SNIPSTART nodejs-hello-client
import { Connection } from '@temporalio/client';
import { Example } from '@interfaces/workflows';

async function run() {
  // Connect to localhost with default ConnectionOptions,
  // pass options to the Connection constructor to configure TLS and other settings.
  const connection = new Connection();
  // Create a typed client using the Example Workflow interface,
  // Workflow will be started in the "default" namespace unless specified otherwise.
  const example = connection.workflow<Example>('example', { taskQueue: 'tutorial' });
  const result = await example.start('Temporal');
  console.log(result); // Hello, Temporal
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
// @@@SNIPEND
