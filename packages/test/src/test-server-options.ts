import test from 'ava';
import { normalizeTlsConfig } from '@temporalio/common';

test('normalizeTlsConfig turns null to undefined', (t) => {
  t.is(normalizeTlsConfig(null), undefined);
});

test('normalizeTlsConfig turns false to undefined', (t) => {
  t.is(normalizeTlsConfig(false), undefined);
});

test('normalizeTlsConfig turns 0 to undefined', (t) => {
  t.is(normalizeTlsConfig(0 as any), undefined);
});

test('normalizeTlsConfig turns true to object', (t) => {
  t.deepEqual(normalizeTlsConfig(true), {});
});

test('normalizeTlsConfig turns 1 to object', (t) => {
  t.deepEqual(normalizeTlsConfig(1 as any), {});
});

test('normalizeTlsConfig passes through undefined', (t) => {
  t.is(normalizeTlsConfig(undefined), undefined);
});

test('normalizeTlsConfig passes through object', (t) => {
  const cfg = { serverNameOverride: 'temporal' };
  t.is(normalizeTlsConfig(cfg), cfg);
});
