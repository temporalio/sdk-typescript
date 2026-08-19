import test from 'ava';
import { ApplicationFailure, createPayloadValidationError, defaultFailureConverter, defaultPayloadConverter } from '..';

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
