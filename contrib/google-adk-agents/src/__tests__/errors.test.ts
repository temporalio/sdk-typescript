/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for `toApplicationFailure`'s status-based retry classification,
 * covering statuses carried on the wrapped `err.response.status` (not just the
 * top-level `err.status`).
 */

import test from 'ava';

import { toApplicationFailure } from '../activities.js';

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
