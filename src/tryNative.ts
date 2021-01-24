import { promisify } from 'util';
import { Worker } from '../native';
import { Workflow } from './engine';
import * as stdlib from './stdlib';

async function run() {
  const worker = new Worker("tasks");
  const scriptName = process.argv[process.argv.length - 1];
  const poll = promisify(worker.poll.bind(worker));

  // Only a single workflow at the moment
  const workflow = await Workflow.create('TODO');
  await stdlib.install(workflow);

  while (true) {
    let res;
    try {
      res = await poll();
    } catch (err) {
      if (/History is over/.test(err.message)) {
        console.log('Done');
        return;
      }
      throw err;
    }
    for (const event of res.history) {
      switch (event.type) {
        case 'WorkflowExecutionStarted': {
          const commands = await workflow.runMain(scriptName);
          console.log({ commands });
          break;
        }
        case 'TimerFired': {
          const commands = await workflow.trigger([{ ...event, taskId: 1 }]);
          console.log({ commands });
          break;
        }
        default:
          // ignore
      }
    }
  }
}

run().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
