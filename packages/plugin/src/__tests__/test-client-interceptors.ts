import test from 'ava';
import type { ClientInterceptors } from '@temporalio/client';
import { SimplePlugin } from '../plugin';

test('SimplePlugin appends Activity and Nexus client interceptors', (t) => {
  const existingActivity = {};
  const existingNexus = {};
  const pluginActivity = {};
  const pluginNexus = {};
  const plugin = new SimplePlugin({
    name: 'interceptor-merge',
    clientInterceptors: { activity: [pluginActivity], nexus: [pluginNexus] },
  });
  const actual = plugin.configureClient({
    interceptors: { activity: [existingActivity], nexus: [existingNexus] },
  }).interceptors;

  t.is(actual?.activity?.length, 2);
  t.is(actual?.activity?.[0], existingActivity);
  t.is(actual?.activity?.[1], pluginActivity);
  t.is(actual?.nexus?.length, 2);
  t.is(actual?.nexus?.[0], existingNexus);
  t.is(actual?.nexus?.[1], pluginNexus);
});

test('SimplePlugin clientInterceptors overrides default behavior', (t) => {
  const original: ClientInterceptors = { activity: [{}], nexus: [{}] };
  const replacement: ClientInterceptors = { activity: [{}], nexus: [{}] };
  const plugin = new SimplePlugin({
    name: 'custom-merge',
    clientInterceptors: (current) => {
      t.is(current, original);
      return replacement;
    },
  });
  t.is(plugin.configureClient({ interceptors: original }).interceptors, replacement);
});
