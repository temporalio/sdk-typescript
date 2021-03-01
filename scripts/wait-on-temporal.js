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
      await client.service.describeNamespace({ namespace: 'default' });
      // We wait an extra 3 seconds after a successful describe namespace because the namespace
      // is not really ready after the call.
      // See: https://github.com/temporalio/temporal/issues/1336
      await new Timer(3000);
      break;
    } catch (err) {
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
