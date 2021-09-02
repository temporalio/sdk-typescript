// Taken from https://jakearchibald.com/2015/tasks-microtasks-queues-and-schedules/
import { Empty } from '../interfaces';

async function execute(): Promise<void> {
  console.log('script start');

  const p1 = new Promise((resolve) => {
    setTimeout(function () {
      console.log('setTimeout');
      resolve(undefined);
    }, 0);
  });

  const p2 = Promise.resolve()
    .then(function () {
      console.log('promise1');
    })
    .then(function () {
      console.log('promise2');
    });

  console.log('script end');
  await Promise.all([p1, p2]);
}

export const tasksAndMicrotasks: Empty = () => ({ execute });
