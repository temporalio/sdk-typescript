import path from 'path';
import { Workflow } from './engine';
import * as stdlib from './stdlib';
export { Workflow };


async function run() {
  const workflow = await Workflow.create();
  await stdlib.install(workflow);
  const example = path.join(__dirname, '../example/lib/index.js');
  console.log(example);
  await workflow.run(example);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
