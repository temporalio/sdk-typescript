import { parentPort, workerData } from 'node:worker_threads';
import { loadVmlessBundle } from '@temporalio/worker/internal/vmless';
import type { WorkflowCreateOptionsInternal } from '@temporalio/workflow/internal/vmless';

async function main(): Promise<void> {
  const loaded = loadVmlessBundle(workerData.bundle);
  const onUnhandledSdkError: Parameters<typeof loaded.api.initRuntime>[2] = (activator, error) => {
    activator.workflowTaskError ??= error;
  };
  const options = workerData.options as WorkflowCreateOptionsInternal[];
  for (const option of options) option.getTimeOfDay = process.hrtime.bigint;
  let initializationFailed = false;
  try {
    loaded.api.initRuntime(
      {
        ...options[0],
        info: { ...options[0].info, workflowType: 'missing' },
      },
      loaded,
      onUnhandledSdkError
    );
  } catch {
    initializationFailed = true;
  }
  const outsideAfterFailure = loaded.api.maybeGetActivator() === undefined;
  const activators = options.map((option) => loaded.api.initRuntime(option, loaded, onUnhandledSdkError));
  const results = await Promise.all(
    activators.map((activator) => loaded.api.runWithActivator(activator, () => activator.workflow!()))
  );
  for (const activator of activators) {
    loaded.api.runWithActivator(activator, () => loaded.api.dispose(activator));
  }
  parentPort!.postMessage({
    results,
    initializationFailed,
    outsideAfterFailure,
    outside: loaded.api.maybeGetActivator() === undefined,
  });
}

void main();
