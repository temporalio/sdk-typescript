import vm from 'node:vm';
import test from 'ava';
import type { PayloadCodec } from '../converter/payload-codec';
import {
  ApplicationFailure,
  ApplicationFailureCategory,
  createPayloadValidationError,
  defaultFailureConverter,
  defaultPayloadConverter,
} from '..';
import { encodePayloadValidationError } from '../internal-non-workflow/payload-validation-error';
import {
  clonePayloadValidationErrorAsRetryable,
  findPayloadValidationError,
  findWorkflowTaskPayloadConversionError,
  isWorkflowTaskPayloadConversionError,
  payloadFreePayloadValidationFailure,
  WorkflowTaskPayloadConversionError,
} from '../internal-workflow/payload-validation-error';

test('findPayloadValidationError finds exact failures through wrapped and cyclic causes', (t) => {
  const failure = createPayloadValidationError({ field: 'invalid' });
  const wrapped = new Error('wrapped', { cause: failure });
  t.is(findPayloadValidationError(failure), failure);
  t.is(findPayloadValidationError(wrapped), failure);

  const cyclic = new Error('cyclic');
  cyclic.cause = cyclic;
  t.is(findPayloadValidationError(cyclic), undefined);
  t.is(findPayloadValidationError(ApplicationFailure.nonRetryable('wrong type', 'OtherError')), undefined);
  t.is(
    findPayloadValidationError(ApplicationFailure.retryable('retryable lookalike', 'PayloadValidationError')),
    undefined
  );
});

test('Workflow Task conversion marker rejects name and property lookalikes', (t) => {
  const lookalike = new Error('lookalike') as Error & { workflowTaskPayloadConversionError?: boolean };
  lookalike.name = 'WorkflowTaskPayloadConversionError';
  lookalike.workflowTaskPayloadConversionError = true;

  t.false(isWorkflowTaskPayloadConversionError(lookalike));

  const failure = createPayloadValidationError({ field: 'completion' });
  const marker = new WorkflowTaskPayloadConversionError(failure);
  const wrapper = new Error('unhandled rejection wrapper', { cause: marker });
  t.is(findWorkflowTaskPayloadConversionError(wrapper), marker);
});

test('payload-free fallback preserves cross-realm cause chains', (t) => {
  const foreignCause = vm.runInNewContext('new Error("foreign cause")') as Error;
  foreignCause.cause = new Error('nested cause');
  const failure = ApplicationFailure.create({
    message: 'Payload validation failed',
    type: 'PayloadValidationError',
    nonRetryable: true,
    cause: foreignCause,
  });

  const encoded = payloadFreePayloadValidationFailure(failure);
  t.is(encoded.cause?.message, 'foreign cause');
  t.is(encoded.cause?.cause?.message, 'nested cause');
});

test('clonePayloadValidationErrorAsRetryable preserves fields without mutation', (t) => {
  const cause = new Error('cause');
  const original = ApplicationFailure.create({
    message: 'Payload validation failed',
    type: 'PayloadValidationError',
    nonRetryable: true,
    details: [{ field: 'invalid' }],
    cause,
    nextRetryDelay: '3s',
    category: ApplicationFailureCategory.BENIGN,
  });
  const clone = clonePayloadValidationErrorAsRetryable(original);

  t.not(clone, original);
  t.false(clone.nonRetryable);
  t.true(original.nonRetryable);
  t.is(clone.message, original.message);
  t.is(clone.type, original.type);
  t.is(clone.details, original.details);
  t.is(clone.cause, cause);
  t.is(clone.nextRetryDelay, original.nextRetryDelay);
  t.is(clone.category, original.category);
});

test('encodePayloadValidationError falls back without details when its codec rejects failure details', async (t) => {
  const codec: PayloadCodec = {
    async encode(): Promise<never> {
      throw new Error('cannot encode failure details');
    },
    async decode(payloads) {
      return payloads;
    },
  };
  const failure = createPayloadValidationError({ field: 'invalid' });
  const encoded = await encodePayloadValidationError(
    { payloadConverter: defaultPayloadConverter, failureConverter: defaultFailureConverter, payloadCodecs: [codec] },
    failure
  );

  t.is(encoded.message, failure.message);
  t.is(encoded.applicationFailureInfo?.type, failure.type);
  t.true(encoded.applicationFailureInfo?.nonRetryable);
  t.is(encoded.applicationFailureInfo?.details, undefined);
});

test('encodePayloadValidationError preserves absent and present details', async (t) => {
  const converter = {
    payloadConverter: defaultPayloadConverter,
    failureConverter: defaultFailureConverter,
    payloadCodecs: [],
  };
  const absent = await encodePayloadValidationError(converter, createPayloadValidationError(undefined));
  const present = await encodePayloadValidationError(converter, createPayloadValidationError({ field: 'invalid' }));

  t.is(absent.applicationFailureInfo?.details?.payloads?.length ?? 0, 0);
  t.is(present.applicationFailureInfo?.details?.payloads?.length, 1);
});
