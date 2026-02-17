import path from 'node:path';
import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities';

async function main() {
  const connection = await NativeConnection.connect({ address: 'localhost:7233' });
  const worker = await Worker.create({
    connection,
    taskQueue: 'test-suite',
    workflowsPath: require.resolve('./workflows'),
    activities,
    maxConcurrentActivityTaskExecutions: 1,
  });
  console.log('Test suite worker started');
  await worker.run();
  console.log('Test suite worker shut down');
}

main().then(
  () => void process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
