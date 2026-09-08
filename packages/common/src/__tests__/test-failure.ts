import vm from 'vm';
import test from 'ava';
import {
  ApplicationFailure,
  createPayloadValidationError,
  defaultFailureConverter,
  defaultPayloadConverter,
  ensureApplicationFailure,
} from '..';

test('ensureApplicationFailure preserves Error.cause through serialization', (t) => {
  const cause = new Error('connection terminated');
  const error = new Error('query failed', { cause });

  const applicationFailure = ensureApplicationFailure(error);
  const failure = defaultFailureConverter.errorToFailure(applicationFailure, defaultPayloadConverter);

  t.is(applicationFailure.cause, cause);
  t.is(failure.cause?.message, cause.message);
});

test('ensureApplicationFailure preserves cross-realm Error.cause chains', (t) => {
  const cause = vm.runInNewContext(
    `new Error('connection terminated', { cause: new Error('connection refused') })`
  ) as Error;
  const error = new Error('query failed', { cause });

  const applicationFailure = ensureApplicationFailure(error);
  const failure = defaultFailureConverter.errorToFailure(applicationFailure, defaultPayloadConverter);

  t.false(cause instanceof Error);
  t.is(applicationFailure.cause, cause);
  t.is(failure.cause?.message, cause.message);
  t.is(failure.cause?.cause?.message, 'connection refused');
});

test('ensureApplicationFailure omits an immediate non-Error cause', (t) => {
  const error = new Error('query failed', { cause: 'connection terminated' });

  const applicationFailure = ensureApplicationFailure(error);
  const failure = defaultFailureConverter.errorToFailure(applicationFailure, defaultPayloadConverter);

  t.is(applicationFailure.cause, undefined);
  t.is(failure.cause, undefined);
});

test('createPayloadValidationError creates a serializable non-retryable ApplicationFailure', (t) => {
  const details = {
    violations: [
      { path: 'user.age', reason: 'must be an int' },
      { path: 'user.name', reason: 'must not be empty' },
    ],
  };

  const error = createPayloadValidationError(details);

  t.true(error instanceof ApplicationFailure);
  t.is(error.message, 'Payload validation failed');
  t.is(error.type, 'PayloadValidationError');
  t.true(error.nonRetryable);
  t.deepEqual(error.details, [details]);

  const encoded = defaultFailureConverter.errorToFailure(error, defaultPayloadConverter);
  const decoded = defaultFailureConverter.failureToError(encoded, defaultPayloadConverter);

  t.true(decoded instanceof ApplicationFailure);
  t.deepEqual((decoded as ApplicationFailure).details, [details]);
});

test('createPayloadValidationError omits nullish details', (t) => {
  for (const details of [null, undefined]) {
    const error = createPayloadValidationError(details);

    t.deepEqual(error.details, []);

    const encoded = defaultFailureConverter.errorToFailure(error, defaultPayloadConverter);
    const decoded = defaultFailureConverter.failureToError(encoded, defaultPayloadConverter);

    t.true(decoded instanceof ApplicationFailure);
    t.deepEqual((decoded as ApplicationFailure).details, []);
  }
});
