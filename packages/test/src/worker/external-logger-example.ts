// @@@SNIPSTART nodejs-external-dependencies-logger-worker
import { Worker, ApplyMode } from '@temporalio/worker';
import { LoggerDependencies } from '../interfaces/dependencies';

async function main() {
  const worker = await Worker.create<{ dependencies: LoggerDependencies }>({
    ...defaultOptions(), // omitted from this sample for brevity
    workDir: __dirname,
    taskQueue: 'sample',
    dependencies: {
      logger: {
        info: {
          fn(workflowInfo, message) {
            console.log('workflow: ', workflowInfo.runId, 'message: ', message);
          },
          applyMode: ApplyMode.ASYNC_IGNORED, // See docs for other modes
          callDuringReplay: false, // The default
        },
      },
    },
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

// Define outside of the snippet
function defaultOptions() {
  return {
    nodeModulesPath: `${__dirname}/../../../../node_modules`,
  };
}
