import { Worker } from '../worker';

async function run() {
  const worker = new Worker(__dirname, { workflowsPath: `${__dirname}/../../test-workflows/lib` });
  await worker.run("test");
}

run().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
