import { Connection } from '@temporalio/client';
import { Example } from '@interfaces/workflows';

async function run() {
  const connection = new Connection();
  const example = connection.workflow<Example>('example', { taskQueue: 'tutorial' });
  const result = await example.start('Temporal');
  console.log(result); // Hello, Temporal
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
