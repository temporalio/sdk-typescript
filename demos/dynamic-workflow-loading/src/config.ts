import path from 'node:path';

export const TASK_QUEUES = ['tenant-alpha', 'tenant-beta', 'tenant-gamma'] as const;
export const WORKFLOW_TYPE = 'customerWorkflow';

const SAFE_TASK_QUEUE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function getTaskQueue(env: NodeJS.ProcessEnv = process.env): string {
  const taskQueue = env['TEMPORAL_TASK_QUEUE'];

  if (taskQueue === undefined || taskQueue.length === 0) {
    throw new Error('Missing required environment variable: TEMPORAL_TASK_QUEUE');
  }
  if (!SAFE_TASK_QUEUE.test(taskQueue)) {
    throw new Error(
      'TEMPORAL_TASK_QUEUE must contain only letters, numbers, underscores, and hyphens and must start with a letter or number'
    );
  }

  return taskQueue;
}

export function getBundlePath(taskQueue: string): string {
  return path.resolve(__dirname, '..', 'bundles', `${taskQueue}.js`);
}

export function getDemoRoot(): string {
  return path.resolve(__dirname, '..');
}
