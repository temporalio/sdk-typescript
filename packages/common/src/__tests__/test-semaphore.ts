import test from 'ava';
import { Semaphore } from '../concurrency/semaphore';

// Lets the event loop run every async step that is currently ready
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// A one-shot gate
const createGate = (): { wait: () => Promise<void>; open: () => void } => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait: () => opened, open };
};

test('caps concurrent holders at the permit count', async (t) => {
  const semaphore = new Semaphore(2);
  let active = 0;
  let maxActive = 0;
  const gate = createGate();
  const hold = async () => {
    await semaphore.acquire();
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gate.wait();
    active -= 1;
    semaphore.release();
  };

  const holders = Array.from({ length: 6 }, hold);
  await tick();
  t.is(maxActive, 2);

  gate.open();
  await Promise.all(holders);
  t.is(maxActive, 2, 'never exceeded the permit count as the queued holders drained');
});

test('hands a released permit to waiters in acquire order', async (t) => {
  const semaphore = new Semaphore(1);
  const order: number[] = [];
  const hold = async (id: number) => {
    await semaphore.acquire();
    order.push(id);
    await tick();
    semaphore.release();
  };

  await Promise.all([hold(1), hold(2), hold(3)]);
  t.deepEqual(order, [1, 2, 3]);
});
