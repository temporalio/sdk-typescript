import { Workflow } from './engine';
import * as stdlib from './stdlib';
export { Workflow };
import { httpGet } from '../testActivities';

async function run() {
  const scriptName = process.argv[process.argv.length - 1];
  const workflow = await Workflow.create();
  await stdlib.install(workflow);
  await workflow.injectActivity('httpGet', httpGet);
  await workflow.run(scriptName);
}

run().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
