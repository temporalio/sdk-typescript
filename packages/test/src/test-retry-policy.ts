import test from 'ava';
import { ValueError } from '@temporalio/common';
import { compileRetryPolicy, msToTs } from '@temporalio/internal-workflow-common';

test('compileRetryPolicy validates intervals are not 0', (t) => {
  t.throws(() => compileRetryPolicy({ initialInterval: 0 }), {
    instanceOf: ValueError,
    message: 'RetryPolicy.initialInterval cannot be 0',
  });
  t.throws(() => compileRetryPolicy({ initialInterval: '0 ms' }), {
    instanceOf: ValueError,
    message: 'RetryPolicy.initialInterval cannot be 0',
  });
  t.throws(() => compileRetryPolicy({ maximumInterval: 0 }), {
    instanceOf: ValueError,
    message: 'RetryPolicy.maximumInterval cannot be 0',
  });
  t.throws(() => compileRetryPolicy({ maximumInterval: '0 ms' }), {
    instanceOf: ValueError,
    message: 'RetryPolicy.maximumInterval cannot be 0',
  });
});

test('compileRetryPolicy validates maximumInterval is not less than initialInterval', (t) => {
  t.throws(() => compileRetryPolicy({ maximumInterval: '1 ms', initialInterval: '3 ms' }), {
    instanceOf: ValueError,
    message: 'RetryPolicy.maximumInterval cannot be less than its initialInterval',
  });
});

test('compileRetryPolicy validates backoffCoefficient is greater than 0', (t) => {
  t.throws(() => compileRetryPolicy({ backoffCoefficient: 0 }), {
    instanceOf: ValueError,
    message: 'RetryPolicy.backoffCoefficient must be greater than 0',
  });
});

test('compileRetryPolicy validates maximumAttempts greater than 0', (t) => {
  t.throws(() => compileRetryPolicy({ maximumAttempts: 0 }), {
    instanceOf: ValueError,
    message: 'RetryPolicy.maximumAttempts must be greater than 0',
  });
});

test('compileRetryPolicy validates maximumAttempts is an integer', (t) => {
  t.throws(() => compileRetryPolicy({ maximumAttempts: 3.1415 }), {
    instanceOf: ValueError,
    message: 'RetryPolicy.maximumAttempts must be an integer',
  });
});

test('compileRetryPolicy validates maximumAttempts is not POSITIVE_INFINITY', (t) => {
  t.throws(() => compileRetryPolicy({ maximumAttempts: Number.POSITIVE_INFINITY }), {
    instanceOf: ValueError,
    message: 'RetryPolicy.maximumAttempts must be an integer',
  });
});

test('compileRetryPolicy defaults initialInterval to 1 second', (t) => {
  t.deepEqual(compileRetryPolicy({}), {
    initialInterval: msToTs('1 second'),
    maximumInterval: undefined,
    backoffCoefficient: undefined,
    maximumAttempts: undefined,
    nonRetryableErrorTypes: undefined,
  });
});

test('compileRetryPolicy compiles a valid policy', (t) => {
  t.deepEqual(
    compileRetryPolicy({
      maximumInterval: '4 ms',
      initialInterval: '3 ms',
      backoffCoefficient: 2,
      maximumAttempts: 3,
      nonRetryableErrorTypes: ['Error'],
    }),
    {
      initialInterval: msToTs('3 ms'),
      maximumInterval: msToTs('4 ms'),
      backoffCoefficient: 2,
      maximumAttempts: 3,
      nonRetryableErrorTypes: ['Error'],
    }
  );
});
