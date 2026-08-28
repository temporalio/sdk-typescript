import { readFile } from 'node:fs/promises';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import { NativeConnection, Worker } from '@temporalio/worker';
import { getBundlePath, getTaskQueue } from './config';

export async function loadWorkflowBundle(taskQueue: string): Promise<{ bundlePath: string; code: string }> {
  const bundlePath = getBundlePath(taskQueue);

  try {
    return { bundlePath, code: await readFile(bundlePath, 'utf8') };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `No Workflow bundle is available for Task Queue "${taskQueue}" at ${bundlePath}. Run "pnpm build:bundles" first. (${cause})`,
      { cause: error }
    );
  }
}

export async function runWorker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const taskQueue = getTaskQueue(env);
  const { bundlePath, code } = await loadWorkflowBundle(taskQueue);
  const { connectionOptions, namespace } = loadClientConnectConfig({ overrideEnvVars: env as Record<string, string> });
  const connection = await NativeConnection.connect(connectionOptions);

  try {
    const worker = await Worker.create({
      connection,
      namespace: namespace ?? 'default',
      taskQueue,
      workflowBundle: { code },
    });

    console.log(`Polling Task Queue "${taskQueue}" with Workflow bundle ${bundlePath}`);
    await worker.run();
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  runWorker().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
