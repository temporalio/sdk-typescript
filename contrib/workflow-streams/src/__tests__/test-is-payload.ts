/**
 * Unit tests for Payload detection used by workflow stream publish.
 *
 * Plain application objects often carry `metadata: {}` (OpenAI Response,
 * Stripe Customer, etc.). Those must go through the payload converter —
 * not be treated as pre-built Temporal Payloads.
 */

import type { TestFn } from 'ava';
import anyTest from 'ava';
import { defaultPayloadConverter, type Payload } from '@temporalio/common';
import { isPayload } from '../is-payload';

const test = anyTest as TestFn;
const encoder = new TextEncoder();

test('rejects plain objects with empty metadata', (t) => {
  t.false(isPayload({ id: 'resp_1', text: 'hello', metadata: {} }));
  t.false(isPayload({ metadata: {} }));
  t.false(isPayload({ metadata: {}, data: 'not-bytes' }));
});

test('rejects metadata that is Map, Date, or null-prototype without encoding', (t) => {
  t.false(isPayload({ metadata: new Map() }));
  t.false(isPayload({ metadata: new Date() }));
  t.false(isPayload({ metadata: Object.create(null) }));
});

test('rejects objects whose metadata values are not Uint8Array', (t) => {
  t.false(isPayload({ metadata: { encoding: 'json/plain' } }));
  t.false(isPayload({ metadata: { encoding: encoder.encode('json/plain'), extra: 'str' } }));
  t.false(
    isPayload({
      metadata: { encoding: encoder.encode('json/plain') },
      data: 'not-bytes',
    })
  );
});

test('accepts real Payloads from the default converter', (t) => {
  const json = defaultPayloadConverter.toPayload({ id: 'resp_1', text: 'hello', metadata: {} });
  t.true(isPayload(json));

  const binary = defaultPayloadConverter.toPayload(encoder.encode('raw'));
  t.true(isPayload(binary));

  const nullPayload = defaultPayloadConverter.toPayload(null);
  t.true(isPayload(nullPayload));
});

test('accepts hand-built Payloads with encoding Uint8Array', (t) => {
  const payload: Payload = {
    metadata: { encoding: encoder.encode('json/plain') },
    data: encoder.encode('"hello"'),
  };
  t.true(isPayload(payload));

  // Null encoding may omit data.
  t.true(isPayload({ metadata: { encoding: encoder.encode('binary/null') } }));
});

test('rejects primitives and non-objects', (t) => {
  t.false(isPayload(null));
  t.false(isPayload(undefined));
  t.false(isPayload('hello'));
  t.false(isPayload(42));
  t.false(isPayload([]));
});
