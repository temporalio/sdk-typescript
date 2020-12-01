import ivm from 'isolated-vm';
import { Workflow, ApplyMode } from './engine';

export async function install(workflow: Workflow) {
  const timeoutIdsToTimeouts: Map<number, NodeJS.Timer> = new Map();
  let lastTimeoutId: number = 0;

  await workflow.inject('Date', () => new Date(123));
  await workflow.inject('Date.now', () => 123);
  await workflow.inject('Math.random', () => .456);
  await workflow.inject('console.log', async (...args: unknown[]) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    console.log(...args);
  }, ApplyMode.IGNORED);

  await workflow.inject('setTimeout', async (
    callback: ivm.Reference<Function>,
    msRef: ivm.Reference<number>,
    ...args: ivm.Reference<any>[]
  ) => {
    const ms = msRef.copySync(); // Copy sync since the isolate executes setTimeout with EvalMode.SYNC
    await new Promise((resolve) => setTimeout(resolve, 200));
    const timeout = setTimeout(async () => {
      await callback.apply(undefined, args.map((arg) => arg.derefInto()), { arguments: { copy: true } });
    }, ms);
    const timeoutId = ++lastTimeoutId;
    timeoutIdsToTimeouts.set(timeoutId, timeout);
    return timeoutId;
  }, ApplyMode.SYNC_PROMISE, {
    arguments: { reference: true },
    result: {},
  });

  await workflow.inject('clearTimeout', (timeoutId: number) => {
    const timeout = timeoutIdsToTimeouts.get(timeoutId);
    if (timeout === undefined) {
      throw new Error('Invalid timeoutId');
    }
    clearTimeout(timeout);
    timeoutIdsToTimeouts.delete(timeoutId);
  });
}
