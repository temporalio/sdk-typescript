// Pure unit tests — no workers, no servers, no test workflow environment.
import test from 'ava';
import { APIError } from 'openai';
import type { ModelProvider, ModelRequest, ModelResponse } from '@openai/agents-core';
import { ApplicationFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import { createModelActivity } from '../worker/activities';
import type { InvokeModelActivityInput, SerializedModelRequest } from '../common/serialized-model';

function minimalRequest(): SerializedModelRequest {
  return {
    input: 'hi',
    modelSettings: {},
    tools: [],
    toolsExplicitlyProvided: false,
    outputType: 'text',
    handoffs: [],
    tracing: false,
    overridePromptModel: false,
  };
}

function throwingProvider(err: unknown): ModelProvider {
  return {
    getModel: () => ({
      async getResponse(_request: ModelRequest): Promise<ModelResponse> {
        throw err;
      },
      // eslint-disable-next-line require-yield
      async *getStreamedResponse() {
        throw new Error('unused');
      },
    }),
  };
}

async function runWithError(err: unknown): Promise<ApplicationFailure> {
  const { invokeModelActivity } = createModelActivity(throwingProvider(err));
  const input: InvokeModelActivityInput = { modelName: 'test-model', request: minimalRequest() };
  const env = new MockActivityEnvironment();
  try {
    await env.run(() => invokeModelActivity(input));
    throw new Error('expected throw');
  } catch (caught) {
    if (caught instanceof ApplicationFailure) return caught;
    throw caught;
  }
}

test('classifier: 429 → RateLimit, retryable', async (t) => {
  const fail = await runWithError(new APIError(429, undefined, 'rate limited', new Headers()));
  t.is(fail.type, 'ModelInvocationError.RateLimit');
  t.false(fail.nonRetryable);
});

test('classifier: 400 → BadRequest, non-retryable', async (t) => {
  const fail = await runWithError(new APIError(400, undefined, 'bad request', new Headers()));
  t.is(fail.type, 'ModelInvocationError.BadRequest');
  t.true(fail.nonRetryable);
});

test('classifier: 401 → Authentication, non-retryable', async (t) => {
  const fail = await runWithError(new APIError(401, undefined, 'unauthorized', new Headers()));
  t.is(fail.type, 'ModelInvocationError.Authentication');
  t.true(fail.nonRetryable);
});

test('classifier: 403 → Authentication, non-retryable', async (t) => {
  const fail = await runWithError(new APIError(403, undefined, 'forbidden', new Headers()));
  t.is(fail.type, 'ModelInvocationError.Authentication');
  t.true(fail.nonRetryable);
});

test('classifier: 408 → Timeout, retryable', async (t) => {
  const fail = await runWithError(new APIError(408, undefined, 'timeout', new Headers()));
  t.is(fail.type, 'ModelInvocationError.Timeout');
  t.false(fail.nonRetryable);
});

test('classifier: 409 → Conflict, retryable', async (t) => {
  const fail = await runWithError(new APIError(409, undefined, 'conflict', new Headers()));
  t.is(fail.type, 'ModelInvocationError.Conflict');
  t.false(fail.nonRetryable);
});

test('classifier: 422 → BadRequest, non-retryable', async (t) => {
  const fail = await runWithError(new APIError(422, undefined, 'unprocessable', new Headers()));
  t.is(fail.type, 'ModelInvocationError.BadRequest');
  t.true(fail.nonRetryable);
});

test('classifier: 500 → ServerError, retryable', async (t) => {
  const fail = await runWithError(new APIError(500, undefined, 'server error', new Headers()));
  t.is(fail.type, 'ModelInvocationError.ServerError');
  t.false(fail.nonRetryable);
});

test('classifier: 503 → ServerError, retryable', async (t) => {
  const fail = await runWithError(new APIError(503, undefined, 'service unavailable', new Headers()));
  t.is(fail.type, 'ModelInvocationError.ServerError');
  t.false(fail.nonRetryable);
});

test('classifier: 418 (unhandled status) → generic ModelInvocationError, non-retryable', async (t) => {
  const fail = await runWithError(new APIError(418, undefined, "I'm a teapot", new Headers()));
  t.is(fail.type, 'ModelInvocationError');
  t.true(fail.nonRetryable);
});

test('classifier: retry-after-ms header sets nextRetryDelay (ms)', async (t) => {
  const headers = new Headers({ 'retry-after-ms': '5000' });
  const fail = await runWithError(new APIError(429, undefined, 'rate limited', headers));
  t.is(fail.nextRetryDelay, 5000);
});

test('classifier: retry-after header (seconds) sets nextRetryDelay (ms)', async (t) => {
  const headers = new Headers({ 'retry-after': '3' });
  const fail = await runWithError(new APIError(429, undefined, 'rate limited', headers));
  t.is(fail.nextRetryDelay, 3000);
});

test('classifier: retry-after-ms wins over retry-after', async (t) => {
  const headers = new Headers({ 'retry-after-ms': '5000', 'retry-after': '99' });
  const fail = await runWithError(new APIError(429, undefined, 'rate limited', headers));
  t.is(fail.nextRetryDelay, 5000);
});

test('classifier: x-should-retry=true overrides non-retryable 400 to retryable', async (t) => {
  const headers = new Headers({ 'x-should-retry': 'true' });
  const fail = await runWithError(new APIError(400, undefined, 'bad request', headers));
  t.false(fail.nonRetryable);
  t.is(fail.type, 'ModelInvocationError.BadRequest');
});

test('classifier: x-should-retry=false overrides retryable 429 to non-retryable', async (t) => {
  const headers = new Headers({ 'x-should-retry': 'false' });
  const fail = await runWithError(new APIError(429, undefined, 'rate limited', headers));
  t.true(fail.nonRetryable);
  t.is(fail.type, 'ModelInvocationError.RateLimit');
});

test('classifier: plain Error (no APIError) → generic ModelInvocationError, retryable, cause set', async (t) => {
  const original = new Error('connection refused');
  const fail = await runWithError(original);
  t.is(fail.type, 'ModelInvocationError');
  t.false(fail.nonRetryable);
  t.is(fail.cause, original);
});

test('classifier: non-Error string throw is wrapped as Error and set as cause', async (t) => {
  const fail = await runWithError('custom string error');
  t.is(fail.type, 'ModelInvocationError');
  t.false(fail.nonRetryable);
  t.true(fail.cause instanceof Error);
  t.is((fail.cause as Error).message, 'custom string error');
});

test('classifier: non-Error numeric throw is wrapped as Error', async (t) => {
  const fail = await runWithError(42);
  t.is(fail.type, 'ModelInvocationError');
  t.false(fail.nonRetryable);
  t.true(fail.cause instanceof Error);
  t.is((fail.cause as Error).message, '42');
});
