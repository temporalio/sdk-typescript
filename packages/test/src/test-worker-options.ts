import test from 'ava';
import { Runtime } from '@temporalio/worker';
import { compileWorkerOptions, toNativeWorkerOptions } from '@temporalio/worker/lib/worker-options';
import { defaultOptions } from './mock-native-worker';

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

test('forwards a positive maxWorkflowThreadHeapMiB to the compiled options', (t) => {
  const runtime = Runtime.instance();
  const compiled = compileWorkerOptions(
    { ...defaultOptions, maxWorkflowThreadHeapMiB: 512 },
    runtime.logger,
    runtime.metricMeter
  );

  t.is(compiled.maxWorkflowThreadHeapMiB, 512);
});

test('leaves maxWorkflowThreadHeapMiB undefined by default', (t) => {
  const runtime = Runtime.instance();
  const compiled = compileWorkerOptions({ ...defaultOptions }, runtime.logger, runtime.metricMeter);

  t.is(compiled.maxWorkflowThreadHeapMiB, undefined);
});

for (const value of [-1, 0]) {
  test(`rejects invalid maxWorkflowThreadHeapMiB ${value}`, (t) => {
    const runtime = Runtime.instance();
    t.throws(
      () =>
        compileWorkerOptions(
          { ...defaultOptions, maxWorkflowThreadHeapMiB: value },
          runtime.logger,
          runtime.metricMeter
        ),
      {
        instanceOf: TypeError,
        message: 'maxWorkflowThreadHeapMiB must be a positive number',
      }
    );
  });
}
