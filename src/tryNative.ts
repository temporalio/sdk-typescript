import { promisify } from 'util';
import { newWorker, workerPoll, PollCallback } from '../native';
import { Workflow } from './engine';
import * as stdlib from './stdlib';

async function run() {
  const worker = newWorker("tasks");
  const scriptName = process.argv[process.argv.length - 1];
  const poll = promisify((callback: PollCallback) => workerPoll(worker, callback));

  // Only a single workflow at the moment
  const workflow = await Workflow.create('TODO');
  await stdlib.install(workflow);

  while (true) {
    const res = await poll();
    if (res === undefined) {
      console.error('Unexpected undefined poll result');
      return;
    }
    if (Object.keys(res).length === 0) {
      console.log('done');
      return;
    }
    console.log(res);
    switch (res.type) {
      case 'StartWorkflow': {
        const commands = await workflow.runMain(scriptName);
        console.log(commands[0]);
        break;
      }
      case 'CompleteTimer': {
        const commands = await workflow.trigger(res);
        console.log(commands[0]);
        break;
      }
      default:
        // ignore
    }
  }
}

run().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
