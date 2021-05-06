import { Worker } from '@temporalio/worker';

async function main() {
  const worker = await Worker.create({
    workflowsPath: `${__dirname}/../../test-workflows/lib`,
    activitiesPath: `${__dirname}/../../test-activities/lib`,
    nodeModulesPath: `${__dirname}/../../../node_modules`,
    taskQueue: 'test',
  });
  await worker.run();
  console.log('Worker gracefully shutdown');
}

main().then(
  () => void process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
