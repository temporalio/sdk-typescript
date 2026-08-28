import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bundleWorkflowCode } from '@temporalio/worker';
import { getBundlePath, getDemoRoot, TASK_QUEUES } from './config';

export async function buildWorkflowBundles(): Promise<void> {
  await mkdir(path.join(getDemoRoot(), 'bundles'), { recursive: true });

  for (const taskQueue of TASK_QUEUES) {
    const workflowsPath = path.join(getDemoRoot(), 'src', 'workflows', `${taskQueue}.ts`);
    const bundlePath = getBundlePath(taskQueue);
    const { code } = await bundleWorkflowCode({ workflowsPath });

    await writeFile(bundlePath, code, 'utf8');
    console.log(`Built ${taskQueue}: ${bundlePath}`);
  }
}

if (require.main === module) {
  buildWorkflowBundles().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
