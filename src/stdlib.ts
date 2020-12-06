import seedrandom from 'seedrandom';
import { Workflow, ApplyMode } from './engine';

export async function install(workflow: Workflow) {
  const rng = seedrandom(workflow.id);

  await workflow.inject('Date', () => new Date(123));
  await workflow.inject('Date.now', () => 123);
  await workflow.inject('Math.random', rng);
  await workflow.inject(
    'console.log',
    console.log,
  );
  // workflow.timeline.generateActivity('console.log', console.log),
  // await workflow.inject(
  //   'console.log',
  //   workflow.timeline.generateActivity('console.log', async (...args: any[]) => void console.log(...args)),
  //   ApplyMode.SYNC_PROMISE,
  //   {
  //     result: {},
  //   },
  // );

  await workflow.inject('setTimeout', workflow.timeline.generateTimer(), ApplyMode.SYNC, {
    arguments: { reference: true },
    result: {},
  });

  await workflow.inject('clearTimeout', (timeoutId: number) => {
    // const timeout = timeoutIdsToTimeouts.get(timeoutId);
    // if (timeout === undefined) {
    //   throw new Error('Invalid timeoutId');
    // }
    // clearTimeout(timeout);
    // timeoutIdsToTimeouts.delete(timeoutId);
  });
}
