import test from 'ava';
import { EventTargetPolyfill } from '../workflow/load-polyfills';

test('EventTargetPolyfill: dispatchEvent invokes registered listeners with the event', (t) => {
  const et = new EventTargetPolyfill();
  let received: any;
  et.addEventListener('foo', (ev: any) => {
    received = ev;
  });
  const event = { type: 'foo', payload: 42 } as any;
  et.dispatchEvent(event);
  t.is(received?.payload, 42);
});

test('EventTargetPolyfill: one throwing listener does not block subsequent listeners', (t) => {
  const et = new EventTargetPolyfill();
  const calls: string[] = [];
  et.addEventListener('boom', () => {
    calls.push('first');
    throw new Error('listener bug');
  });
  et.addEventListener('boom', () => {
    calls.push('second');
  });
  t.notThrows(() => et.dispatchEvent({ type: 'boom' } as any));
  t.deepEqual(calls, ['first', 'second']);
});

test('EventTargetPolyfill: dispatchEvent sets event.target and event.currentTarget', (t) => {
  const et = new EventTargetPolyfill();
  const event: any = { type: 'tag' };
  et.addEventListener('tag', () => {});
  et.dispatchEvent(event);
  t.is(event.target, et);
  t.is(event.currentTarget, et);
});

test('EventTargetPolyfill: removeEventListener removes the listener', (t) => {
  const et = new EventTargetPolyfill();
  const calls: number[] = [];
  const listener = () => calls.push(1);
  et.addEventListener('x', listener);
  et.removeEventListener('x', listener);
  et.dispatchEvent({ type: 'x' } as any);
  t.deepEqual(calls, []);
});
