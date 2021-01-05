import { Workflow } from '../../lib/engine';
import * as stdlib from '../../lib/stdlib';
import * as activities from '../../testActivities';

async function run() {
  const scriptName = process.argv[process.argv.length - 1];
  const workflow = await Workflow.create();
  await stdlib.install(workflow);
  await workflow.registerActivities({ '@activities': activities });
  await workflow.run(scriptName);
}

run().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
