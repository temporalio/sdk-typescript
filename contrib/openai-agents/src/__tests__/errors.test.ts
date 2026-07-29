import test from 'ava';
import { ApplicationFailure, ActivityFailure } from '@temporalio/common';
import { unwrapTemporalFailure } from '../common/errors';
import { normalizeAgentsRunError } from '../workflow/runner';

test('unwrapTemporalFailure: plain Error returns undefined', (t) => {
  t.is(unwrapTemporalFailure(new Error('nope')), undefined);
});

test('unwrapTemporalFailure: finds TemporalFailure in cause chain', (t) => {
  const tf = new ActivityFailure('Activity task failed', 'someActivity', undefined, undefined, undefined);
  const wrapped = new Error('outer', { cause: tf });
  t.is(unwrapTemporalFailure(wrapped), tf);
});

test('unwrapTemporalFailure: finds TemporalFailure inside AggregateError errors', (t) => {
  const tf = new ActivityFailure('Activity task failed', 'someActivity', undefined, undefined, undefined);
  const agg = new AggregateError([new Error('a'), tf, new Error('b')]);
  t.is(unwrapTemporalFailure(agg), tf);
});

test('unwrapTemporalFailure: self-referential cause does not infinite-loop', (t) => {
  const cyclic: any = new Error('cyclic');
  cyclic.cause = cyclic;
  t.is(unwrapTemporalFailure(cyclic), undefined);
});

test('unwrapTemporalFailure: undefined / null inputs return undefined', (t) => {
  t.is(unwrapTemporalFailure(undefined), undefined);
  t.is(unwrapTemporalFailure(null), undefined);
});

test('normalizeAgentsRunError: TemporalFailure in cause chain is re-raised as-is', (t) => {
  const tf = new ActivityFailure('inner', 'someActivity', undefined, undefined, undefined);
  const wrapped = new Error('outer', { cause: tf });
  t.is(normalizeAgentsRunError(wrapped), tf);
});

test('normalizeAgentsRunError: plain Error becomes AgentsWorkflowError ApplicationFailure with original as cause', (t) => {
  const original = new Error('user instructions threw');
  const result = normalizeAgentsRunError(original);
  t.true(result instanceof ApplicationFailure);
  const fail = result as ApplicationFailure;
  t.is(fail.type, 'AgentsWorkflowError');
  t.true(fail.nonRetryable);
  t.is(fail.cause, original);
  t.regex(fail.message, /Agent workflow failed: user instructions threw/);
});

test('normalizeAgentsRunError: non-Error value is rethrown as-is', (t) => {
  t.is(normalizeAgentsRunError('plain string'), 'plain string');
  t.is(normalizeAgentsRunError(42), 42);
  t.is(normalizeAgentsRunError(null), null);
});
