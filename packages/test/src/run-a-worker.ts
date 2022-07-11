import arg from 'arg';
import { Worker, Runtime, DefaultLogger, LogLevel } from '@temporalio/worker';
import * as activities from './activities';

async function main() {
  const argv = arg({
    '--log-level': String,
  });
  if (argv['--log-level']) {
    const logLevel = argv['--log-level'].toUpperCase();
    Runtime.install({
      logger: new DefaultLogger(logLevel as LogLevel),
      telemetryOptions: {
        tracingFilter: 'temporal_sdk_core=DEBUG',
        logging: { forward: { level: logLevel as LogLevel } },
      },
    });
  }
  const worker = await Worker.create({
    activities,
    workflowsPath: require.resolve('./workflows'),
    taskQueue: 'test',
  });
  await worker.run();
  console.log('Worker gracefully shutdown');
}

main().then(
  () => void process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
