// This is an ESM and has the mjs extension so it can be run in commonjs and ESM projects alike
import { Connection } from '@temporalio/client';

class Timer {
  constructor(ms) {
    this.ms = ms;
  }

  then(resolve) {
    setTimeout(resolve, this.ms);
  }
}

const maxAttempts = 100;
const retryIntervalSecs = 1;

try {
  for (let attempt = 1; attempt <= maxAttempts; ++attempt) {
    try {
      const client = new Connection();
      // Workaround for describeNamespace returning even though namespace is not registered yet
      // See: https://github.com/temporalio/temporal/issues/1336
      await client.service.getWorkflowExecutionHistory({
        namespace: 'default',
        execution: { workflowId: 'fake', runId: '26323773-ab30-4442-9a20-c5640b31a7a3' },
      });
    } catch (err) {
      if (err.details.includes('workflow history not found') || err.details.includes('operation GetCurrentExecution')) {
        break;
      }
      if (attempt === maxAttempts) {
        throw err;
      }
      await new Timer(retryIntervalSecs * 1000);
    }
  }
} catch (err) {
  console.error('Failed to connect', err);
  process.exit(1);
}

console.log('Connected');
process.exit(0);
