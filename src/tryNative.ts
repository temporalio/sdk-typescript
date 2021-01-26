// import { promisify } from 'util';
import { newWorker, workerPoll } from '../native';
import { Workflow } from './engine';
import * as stdlib from './stdlib';

async function run() {
  const worker = newWorker("tasks");
  // const scriptName = process.argv[process.argv.length - 1];
  // const poll = promisify((callback: PollCallback) => workerPoll(worker, callback));

  // Only a single workflow at the moment
  const workflow = await Workflow.create('TODO');
  await stdlib.install(workflow);
  workerPoll(worker, (err, result) => {
    console.log('poll', { err, result });
  });
}

run().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
