import test from 'ava';
import type { ClientInterceptors } from '@temporalio/client';
import { SimplePlugin } from '@temporalio/plugin';

const first = { start: async () => undefined };
const second = { start: async () => undefined };

// Object identity and order matter: these interceptors must execute as one chain.
function interceptors(marker: object): ClientInterceptors {
  return {
    workflow: [marker],
    schedule: [marker],
    activity: [marker],
    nexus: [marker],
  };
}

for (const path of ['client', 'worker', 'replay'] as const) {
  for (const existing of [false, true]) {
    for (const supplied of [false, true]) {
      test(`SimplePlugin ${path} preserves all client interceptor families (existing=${existing}, plugin=${supplied})`, (t) => {
        const original = existing ? interceptors(first) : undefined;
        const addition = supplied ? interceptors(second) : undefined;
        const plugin = new SimplePlugin({
          name: 'interceptor-merge',
          ...(path === 'client' ? { clientInterceptors: addition } : { workerInterceptors: { client: addition } }),
        });
        let actual: ClientInterceptors | undefined;
        if (path === 'client') {
          actual = plugin.configureClient({ interceptors: original }).interceptors;
        } else if (path === 'worker') {
          actual = plugin.configureWorker({ taskQueue: 'unused', interceptors: { client: original } }).interceptors
            ?.client;
        } else {
          actual = plugin.configureReplayWorker({
            workflowBundle: { code: '' },
            interceptors: { client: original },
          }).interceptors?.client;
        }
        const expected = [...(existing ? [first] : []), ...(supplied ? [second] : [])];
        for (const family of ['workflow', 'schedule', 'activity', 'nexus'] as const) {
          t.deepEqual(actual?.[family] ?? [], expected);
        }
        // Configuration must not append into either caller-owned array.
        if (original) t.deepEqual(original, interceptors(first));
        if (addition) t.deepEqual(addition, interceptors(second));
      });
    }
  }
}

test('SimplePlugin preserves Activity and Nexus interceptors when another family is configured', (t) => {
  const original: ClientInterceptors = { activity: [{}], nexus: [{}] };
  const plugin = new SimplePlugin({ name: 'workflow-only', clientInterceptors: { workflow: [{}] } });
  const actual = plugin.configureClient({ interceptors: original }).interceptors;
  t.is(actual?.activity, original.activity);
  t.is(actual?.nexus, original.nexus);
});

test('SimplePlugin leaves function-based client interceptor configuration in control', (t) => {
  const original = interceptors(first);
  const replacement = interceptors(second);
  const plugin = new SimplePlugin({
    name: 'custom-merge',
    clientInterceptors: (current) => {
      t.is(current, original);
      return replacement;
    },
  });
  t.is(plugin.configureClient({ interceptors: original }).interceptors, replacement);
});
