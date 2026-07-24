import test from 'ava';
import { Runtime } from '@temporalio/worker';
import { compileWorkerOptions, toNativeWorkerOptions } from '@temporalio/worker/lib/worker-options';
import { defaultOptions } from './mock-native-worker';

test('forwards the eager activity execution limit to Core', (t) => {
  const runtime = Runtime.instance();
  const compiled = compileWorkerOptions(
    { ...defaultOptions, maxConcurrentEagerActivityExecutionSize: 7 },
    runtime.logger,
    runtime.metricMeter
  );

  t.is(toNativeWorkerOptions({ ...compiled, buildId: 'test-build-id' }).maxConcurrentEagerActivityExecutionSize, 7);
});
