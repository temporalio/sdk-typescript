import arg from 'arg';
import { Connection } from '@temporalio/client';
import { msToTs } from '@temporalio/internal-workflow-common';
import { SetupArgSpec, setupArgSpec, getRequired } from './args';

async function createNamespace(connection: Connection, namespace: string, maxAttempts = 100, retryIntervalSecs = 1) {
  for (let attempt = 1; attempt <= maxAttempts; ++attempt) {
    try {
      await connection.service.registerNamespace({ namespace, workflowExecutionRetentionPeriod: msToTs('1 day') });
      break;
    } catch (err: any) {
      if (err.details === 'Namespace already exists.') {
        break;
      }
      if (attempt === maxAttempts) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, retryIntervalSecs * 1000));
    }
  }
}

async function waitOnNamespace(connection: Connection, namespace: string, maxAttempts = 100, retryIntervalSecs = 1) {
  const runId = '12345678-1234-1234-1234-1234567890ab';
  for (let attempt = 1; attempt <= maxAttempts; ++attempt) {
    try {
      await connection.service.getWorkflowExecutionHistory({
        namespace,
        execution: { workflowId: 'fake', runId },
      });
    } catch (err: any) {
      if (err.details.includes('workflow history not found') || err.details.includes(runId)) {
        break;
      }
      if (attempt === maxAttempts) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, retryIntervalSecs * 1000));
    }
  }
}

async function main() {
  const args = arg<SetupArgSpec>(setupArgSpec);

  const serverAddress = getRequired(args, '--server-address');
  const namespace = getRequired(args, '--ns');

  const connection = new Connection({ address: serverAddress });

  await createNamespace(connection, namespace);
  console.log('Registered namespace', { namespace });
  await waitOnNamespace(connection, namespace);
  console.log('Wait complete on namespace', { namespace });
}

main()
  .then(() => {
    process.exit();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
