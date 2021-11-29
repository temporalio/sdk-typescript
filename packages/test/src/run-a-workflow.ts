import { WorkflowClient } from '@temporalio/client';
import * as workflows from './workflows';

async function main() {
  const [workflowType, ...argsRaw] = process.argv.slice(2);
  const args = argsRaw.map((v) => JSON.parse(v));
  if (!workflows.hasOwnProperty(workflowType)) {
    throw new TypeError(`Invalid workflowType ${workflowType}`);
  }
  console.log('running', { workflowType, args });

  const client = new WorkflowClient();
  const result = await client.execute(workflows.cancelFakeProgress, {
    workflowId: 'test',
    taskQueue: 'test',
  });
  console.log('complete', { result });
}

main().then(
  () => void process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
