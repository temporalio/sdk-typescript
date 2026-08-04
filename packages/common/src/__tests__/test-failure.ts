import test from 'ava';
import { defaultFailureConverter } from '../converter/data-converter';
import { defaultPayloadConverter } from '../converter/payload-converter';
import { ensureApplicationFailure } from '../failure';

test('preserves Error.cause when converting an application failure', (t) => {
  const cause = new Error('connection terminated');
  const error = new Error('query failed', { cause });

  const applicationFailure = ensureApplicationFailure(error);
  const failure = defaultFailureConverter.errorToFailure(applicationFailure, defaultPayloadConverter);

  t.is(applicationFailure.cause, cause);
  t.is(failure.cause?.message, cause.message);
});
