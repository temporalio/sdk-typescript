import test from 'ava';
import { Runtime, type WorkerOptions } from '@temporalio/worker';
import { compileWorkerOptions, toNativeWorkerOptions } from '@temporalio/worker/internal';
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

for (const [pollsOption, behaviorOption] of [
  ['maxConcurrentWorkflowTaskPolls', 'workflowTaskPollerBehavior'],
  ['maxConcurrentActivityTaskPolls', 'activityTaskPollerBehavior'],
  ['maxConcurrentNexusTaskPolls', 'nexusTaskPollerBehavior'],
] as const) {
  const toNative = (options: Partial<WorkerOptions>) => {
    const runtime = Runtime.instance();
    const compiled = compileWorkerOptions({ ...defaultOptions, ...options }, runtime.logger, runtime.metricMeter);
    return toNativeWorkerOptions({ ...compiled, buildId: 'test-build-id' })[behaviorOption];
  };

  test(`${pollsOption} sets the simple maximum of ${behaviorOption}`, (t) => {
    t.deepEqual(toNative({ [pollsOption]: 2 }), { type: 'simple-maximum', maximum: 2 });
    t.deepEqual(toNative({ [pollsOption]: 20 }), { type: 'simple-maximum', maximum: 20 });
  });

  test(`${pollsOption} is the default maximum of a simple-maximum ${behaviorOption}`, (t) => {
    t.deepEqual(toNative({ [pollsOption]: 2, [behaviorOption]: { type: 'simple-maximum' } }), {
      type: 'simple-maximum',
      maximum: 2,
    });
    t.deepEqual(toNative({ [pollsOption]: 2, [behaviorOption]: { type: 'simple-maximum', maximum: 3 } }), {
      type: 'simple-maximum',
      maximum: 3,
    });
  });
}

function compiledWorkflowTaskSlots(options: Partial<WorkerOptions>) {
  const runtime = Runtime.instance();
  const compiled = compileWorkerOptions({ ...defaultOptions, ...options }, runtime.logger, runtime.metricMeter);
  const supplier = compiled.tuner.workflowTaskSlotSupplier;
  return supplier.type === 'fixed-size' ? supplier.numSlots : undefined;
}

test('maxConcurrentWorkflowTaskExecutions above maxCachedWorkflows is capped to maxCachedWorkflows', (t) => {
  t.is(compiledWorkflowTaskSlots({ maxConcurrentWorkflowTaskExecutions: 40, maxCachedWorkflows: 10 }), 10);
});

test('maxConcurrentWorkflowTaskExecutions below 2 is raised to 2 when the cache is enabled', (t) => {
  t.is(compiledWorkflowTaskSlots({ maxConcurrentWorkflowTaskExecutions: 1, maxCachedWorkflows: 10 }), 2);
});

test('maxConcurrentWorkflowTaskExecutions is not capped when the cache is disabled', (t) => {
  t.is(compiledWorkflowTaskSlots({ maxConcurrentWorkflowTaskExecutions: 40, maxCachedWorkflows: 0 }), 40);
});

test('maxConcurrentWorkflowTaskExecutions within bounds is kept', (t) => {
  t.is(compiledWorkflowTaskSlots({ maxConcurrentWorkflowTaskExecutions: 5, maxCachedWorkflows: 10 }), 5);
});
