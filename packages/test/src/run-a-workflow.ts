import arg from 'arg';
import { WorkflowClient, Connection } from '@temporalio/client';
import * as workflows from './workflows';

async function main() {
  const argv = arg({
    '--workflow-id': String,
  });
  const [workflowType, ...argsRaw] = argv._;
  const args = argsRaw.map((v) => JSON.parse(v));
  const workflowId = argv['--workflow-id'] ?? 'test';
  if (!Object.prototype.hasOwnProperty.call(workflows, workflowType)) {
    throw new TypeError(`Invalid workflowType ${workflowType}`);
  }
  console.log('running', { workflowType, args });

  const connection = await Connection.connect();
  const client = new WorkflowClient({ connection });
  const result = await client.execute(workflowType, {
    workflowId,
    taskQueue: 'test',
    args,
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
