import arg from 'arg';
import { Worker, Runtime, DefaultLogger } from '@temporalio/worker';
import * as activities from './activities';

async function main() {
  const argv = arg({
    '--debug': Boolean,
  });
  if (argv['--debug']) {
    Runtime.install({
      logger: new DefaultLogger('DEBUG'),
      telemetryOptions: {
        tracingFilter: 'temporal_sdk_core=DEBUG',
        logging: { forward: { level: 'DEBUG' } },
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
