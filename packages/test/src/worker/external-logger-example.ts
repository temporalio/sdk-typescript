// @@@SNIPSTART typescript-external-dependencies-logger-worker
import { Worker, InjectedDependencies } from '@temporalio/worker';
import { LoggerDependencies } from '../workflows';

async function main() {
  const dependencies: InjectedDependencies<LoggerDependencies> = {
    logger: {
      info: {
        fn(workflowInfo, message) {
          console.log('workflow: ', workflowInfo.runId, 'message: ', message);
        },
        callDuringReplay: false, // The default
      },
    },
  };
  const worker = await Worker.create({
    workflowsPath: require.resolve('../workflows'),
    taskQueue: 'sample',
    dependencies,
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
// @@@SNIPEND
