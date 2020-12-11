import path from 'path';
import { Workflow } from './engine';
import * as stdlib from './stdlib';
export { Workflow };
import { httpGet } from '../testActivities';

async function run() {
  const example = path.join(__dirname, '../testWorkflows/lib/index.js');

  const workflow = await Workflow.create();
  await stdlib.install(workflow);
  await workflow.injectActivity('httpGet', httpGet);
  await workflow.run(example);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
