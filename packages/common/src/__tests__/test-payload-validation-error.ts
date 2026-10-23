import test from 'ava';
import { isPayloadValidationError } from '../internal-workflow/payload-validation-error';
import { ApplicationFailure, createPayloadValidationError } from '..';

test('isPayloadValidationError matches a PayloadValidationError', (t) => {
  t.true(isPayloadValidationError(createPayloadValidationError({ field: 'x' })));
  t.true(isPayloadValidationError(createPayloadValidationError(undefined)));
});

test('isPayloadValidationError ignores wrapped PayloadValidationErrors', (t) => {
  t.false(isPayloadValidationError(new Error('outer', { cause: createPayloadValidationError(undefined) })));
});

test('isPayloadValidationError ignores other failure types', (t) => {
  t.false(isPayloadValidationError(ApplicationFailure.nonRetryable('nope', 'OtherError')));
  t.false(isPayloadValidationError(new Error('Payload validation failed')));
  t.false(isPayloadValidationError(undefined));
  t.false(isPayloadValidationError('PayloadValidationError'));
});

test('isPayloadValidationError ignores retryable lookalikes', (t) => {
  t.false(
    isPayloadValidationError(ApplicationFailure.retryable('Payload validation failed', 'PayloadValidationError'))
  );
});
