import path from 'node:path';
import { getDemoRoot, TASK_QUEUES } from './config';
import { startChildSupervisor, type ChildSpec } from './child-supervisor';

export function makeWorkerEnvironment(taskQueue: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, TEMPORAL_TASK_QUEUE: taskQueue };
}

export function makeWorkerSpecs(env: NodeJS.ProcessEnv = process.env): ChildSpec[] {
  const workerEntrypoint = path.join(getDemoRoot(), 'lib', 'worker.js');
  return TASK_QUEUES.map((taskQueue) => ({
    name: taskQueue,
    command: process.execPath,
    args: [workerEntrypoint],
    options: { env: makeWorkerEnvironment(taskQueue, env) },
  }));
}

export async function runWorkers(): Promise<void> {
  const supervisor = startChildSupervisor(makeWorkerSpecs());

  process.once('SIGINT', () => {
    process.exitCode = 130;
    supervisor.shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    process.exitCode = 143;
    supervisor.shutdown('SIGTERM');
  });

  await supervisor.completion;
}

if (require.main === module) {
  runWorkers().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
