import { Worker } from '@temporalio/worker';

async function main() {
  const worker = await Worker.create({
    workDir: __dirname,
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
