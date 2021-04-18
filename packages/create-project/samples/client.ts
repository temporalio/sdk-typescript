// @@@SNIPSTART nodejs-hello-client
import { Connection } from '@temporalio/client';
import { Example } from '@interfaces/workflows';

async function run() {
  // Connect to localhost and use the "default" namespace
  const connection = new Connection();
  // Create a typed client for the workflow defined above
  const example = connection.workflow<Example>('example', { taskQueue: 'tutorial' });
  const result = await example.start('Temporal');
  console.log(result); // Hello, Temporal
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
// @@@SNIPEND
