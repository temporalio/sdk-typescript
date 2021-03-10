import { Worker } from '@temporalio/worker';

async function main() {
  const worker = new Worker(__dirname, {
    workflowsPath: `${__dirname}/../../test-workflows/lib`,
    activitiesPath: `${__dirname}/../../test-activities/lib`,
  });
  await worker.run('test');
  console.log('Worker gracefully shutdown');
}

main().then(
  () => void process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
