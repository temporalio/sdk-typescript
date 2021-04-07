const { Connection } = require('@temporalio/client');

class Timer {
  constructor(ms) {
    this.ms = ms;
  }

  then(resolve) {
    setTimeout(resolve, this.ms);
  }
}

async function main(maxAttempts = 100, retryIntervalSecs = 1) {
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
      if (err.details === 'Requested workflow history not found, may have passed retention period.') {
        break;
      }
      if (attempt === maxAttempts) {
        throw err;
      }
      await new Timer(retryIntervalSecs * 1000);
    }
  }
}

main().then(
  () => {
    console.log('Connected');
    process.exit(0);
  },
  (err) => {
    console.error('Failed to connect', err);
    process.exit(1);
  }
);
