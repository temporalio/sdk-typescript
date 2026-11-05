import test from 'ava';
import { Runtime } from '@temporalio/worker';
import { compileWorkerOptions, toNativeWorkerOptions } from '@temporalio/worker/internal';
import { defaultOptions } from './mock-native-worker';

test('accepts VM-less options without restricting the runtime identity', (t) => {
  const runtime = Runtime.instance();
  const compiled = compileWorkerOptions(
    { taskQueue: 'vmless-options', workflowExecutionMode: 'vmless' },
    runtime.logger,
    runtime.metricMeter
  );

  t.is(compiled.workflowExecutionMode, 'vmless');
  t.false(compiled.debugMode);
  t.is(compiled.workflowThreadPoolSize, 1);
});

test('forwards the eager activity reservation limit to Core', (t) => {
  const runtime = Runtime.instance();
  const compiled = compileWorkerOptions(
    { ...defaultOptions, maxEagerActivityReservationsPerWorkflowTask: 7 },
    runtime.logger,
    runtime.metricMeter
  );

  t.is(toNativeWorkerOptions({ ...compiled, buildId: 'test-build-id' }).maxEagerActivityReservationsPerWorkflowTask, 7);
});

test('allows zero eager activity reservations to disable eager execution', (t) => {
  const runtime = Runtime.instance();
  const compiled = compileWorkerOptions(
    { ...defaultOptions, maxEagerActivityReservationsPerWorkflowTask: 0 },
    runtime.logger,
    runtime.metricMeter
  );

  t.is(toNativeWorkerOptions({ ...compiled, buildId: 'test-build-id' }).maxEagerActivityReservationsPerWorkflowTask, 0);
});

for (const value of [-1, 1.5, Number.NaN]) {
  test(`rejects invalid eager activity reservation limit ${value}`, (t) => {
    const runtime = Runtime.instance();
    t.throws(
      () =>
        compileWorkerOptions(
          { ...defaultOptions, maxEagerActivityReservationsPerWorkflowTask: value },
          runtime.logger,
          runtime.metricMeter
        ),
      {
        instanceOf: TypeError,
        message: 'maxEagerActivityReservationsPerWorkflowTask must be a non-negative integer',
      }
    );
  });
}
