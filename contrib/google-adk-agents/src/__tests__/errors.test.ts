/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for `toApplicationFailure`'s status-based retry classification,
 * covering statuses carried on the wrapped `err.response.status` (not just the
 * top-level `err.status`), plus the header-driven retry contract
 * (`x-should-retry`, `retry-after-ms` / `retry-after`).
 */

import test from 'ava';
import { ApplicationFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';

import { createMCPActivities, toApplicationFailure } from '../activities';

test('classifiesResponseStatus404AsNonRetryable', (t) => {
  const failure = toApplicationFailure({ response: { status: 404 } });
  t.is(failure.type, 'GoogleAdkModelError.404');
  t.is(failure.nonRetryable, true);
});

test('classifiesResponseStatus503AsRetryable', (t) => {
  const failure = toApplicationFailure({ response: { status: 503 } });
  t.is(failure.type, 'GoogleAdkModelError.503');
  t.is(failure.nonRetryable, false);
});

test('classifiesTopLevelStatus429AsRetryable', (t) => {
  const failure = toApplicationFailure({ status: 429 });
  t.is(failure.type, 'GoogleAdkModelError.429');
  t.is(failure.nonRetryable, false);
});

test('classifies5xxStatusesAsRetryable', (t) => {
  t.is(toApplicationFailure({ status: 500 }).nonRetryable, false);
  t.is(toApplicationFailure({ status: 502 }).nonRetryable, false);
});

test('classifiesUndefinedStatusAsRetryable', (t) => {
  const failure = toApplicationFailure(new Error('no status'));
  t.is(failure.type, 'GoogleAdkModelError');
  t.is(failure.nonRetryable, false);
});

test('shouldRetryTrueHeaderForcesRetryableOnNonRetryableStatus', (t) => {
  const failure = toApplicationFailure({ status: 404, headers: { 'x-should-retry': 'true' } });
  t.is(failure.type, 'GoogleAdkModelError.404');
  t.is(failure.nonRetryable, false);
});

test('shouldRetryFalseHeaderForcesNonRetryableOnRetryableStatus', (t) => {
  const failure = toApplicationFailure({ status: 503, headers: { 'X-Should-Retry': 'false' } });
  t.is(failure.type, 'GoogleAdkModelError.503');
  t.is(failure.nonRetryable, true);
});

test('retryAfterMsHeaderSetsNextRetryDelay', (t) => {
  const failure = toApplicationFailure({ status: 429, headers: { 'retry-after-ms': '1500' } });
  t.is(failure.nextRetryDelay, '1500 milliseconds');
});

test('retryAfterSecondsHeaderSetsNextRetryDelay', (t) => {
  const failure = toApplicationFailure({ status: 429, headers: { 'retry-after': '10' } });
  t.is(failure.nextRetryDelay, '10 seconds');
});

test('retryAfterHttpDateHeaderSetsNextRetryDelay', (t) => {
  const failure = toApplicationFailure({
    status: 429,
    headers: { 'retry-after': new Date(Date.now() + 30_000).toUTCString() },
  });
  const match = /^(\d+) milliseconds$/.exec(String(failure.nextRetryDelay));
  t.truthy(match);
  const deltaMs = Number(match?.[1]);
  t.true(deltaMs > 25_000 && deltaMs <= 30_000, `expected ~30s delta, got ${deltaMs}ms`);
});

test('retryAfterPastHttpDateLeavesNextRetryDelayUnset', (t) => {
  const failure = toApplicationFailure({
    status: 429,
    headers: { 'retry-after': new Date(Date.now() - 30_000).toUTCString() },
  });
  t.is(failure.nextRetryDelay, undefined);
});

test('retryAfterUnparseableValueLeavesNextRetryDelayUnset', (t) => {
  const failure = toApplicationFailure({ status: 429, headers: { 'retry-after': 'soon-ish' } });
  t.is(failure.nextRetryDelay, undefined);
});

test('applicationFailurePassesThroughUnchanged', (t) => {
  const original = ApplicationFailure.nonRetryable('already classified', 'MyFailureType');
  t.is(toApplicationFailure(original), original);
});

test('numericGrpcCodeIsNotTreatedAsHttpStatus', (t) => {
  const failure = toApplicationFailure(Object.assign(new Error('UNAVAILABLE'), { code: 14 }));
  t.is(failure.type, 'GoogleAdkModelError');
  t.is(failure.nonRetryable, false);
});

test('mcpListToolsClassifiesToolsetResolutionErrors', async (t) => {
  const activities = createMCPActivities({
    bad: () => {
      throw Object.assign(new Error('factory exploded'), { status: 500 });
    },
  });
  const mockEnv = new MockActivityEnvironment();
  const err = await t.throwsAsync(mockEnv.run(activities['bad-listTools'] as () => Promise<unknown>));
  t.true(err instanceof ApplicationFailure);
  t.is((err as ApplicationFailure).type, 'GoogleAdkModelError.500');
});
