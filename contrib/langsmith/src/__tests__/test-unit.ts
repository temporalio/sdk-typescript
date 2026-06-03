/**
 * Pure-function unit tests. These run with no Temporal server and no LangSmith
 * backend — they exercise the propagation codec, query filter,
 * sensitive-key scrubbing, error rendering, run-name builders, and the test
 * harness's own collector / tree renderer.
 *
 * @module
 */

import test from 'ava';

import { ApplicationFailure, ApplicationFailureCategory } from '@temporalio/common';
import {
  HEADER_KEY,
  decodeContextString,
  encodeContextString,
  isInternalQuery,
  readContextHeader,
  scrubSensitive,
  withContextHeader,
  type LangSmithTraceContext,
} from '../propagation';
import {
  describeError,
  runActivityRunName,
  runWorkflowRunName,
  signalChildWorkflowRunName,
  signalExternalWorkflowRunName,
  startActivityRunName,
  startChildWorkflowRunName,
  startNexusOperationRunName,
  startWorkflowRunName,
} from '../run-tree';

import { InMemoryRunCollector, dumpTraces, type CollectedRun } from './helpers';

const CTX: LangSmithTraceContext = {
  'langsmith-trace': '20240101T000000000000Zabc',
  baggage: 'langsmith-metadata={},langsmith-tags=',
};

test('scrubSensitive drops credential-bearing keys and keeps the rest', (t) => {
  const scrubbed = scrubSensitive({
    authorization: 'Bearer x',
    api_key: 'k',
    'x-api-key': 'k',
    cookie: 'c',
    bearerToken: 'b',
    secretValue: 's',
    token: 't',
    password: 'p',
    tenant: 'acme',
    requestId: '42',
  });
  t.deepEqual(scrubbed, { tenant: 'acme', requestId: '42' });
});

test('scrubSensitive returns undefined unchanged', (t) => {
  t.is(scrubSensitive(undefined), undefined);
});

test('scrubSensitive prefix-matches case-insensitively (authentication matches auth)', (t) => {
  t.deepEqual(scrubSensitive({ Authentication: 'x', API_KEY_ID: 'k', username: 'u' }), { username: 'u' });
});

test('isInternalQuery filters Temporal-internal queries', (t) => {
  t.is(isInternalQuery('__temporal_workflow_metadata'), true);
  t.is(isInternalQuery('__stack_trace'), true);
  t.is(isInternalQuery('__enhanced_stack_trace'), true);
});

test('isInternalQuery passes user queries through', (t) => {
  t.is(isInternalQuery('my_query'), false);
  t.is(isInternalQuery('getState'), false);
});

test('context propagation codec round-trips through the Payload header transport', (t) => {
  const headers = withContextHeader({}, CTX);
  t.truthy(headers[HEADER_KEY]);
  t.deepEqual(readContextHeader(headers), CTX);
});

test('context propagation codec leaves the header map untouched when context is undefined', (t) => {
  const headers = { other: { metadata: {}, data: new Uint8Array() } } as never;
  t.is(withContextHeader(headers, undefined), headers);
});

test('context propagation codec round-trips through the Nexus plain-string transport', (t) => {
  t.deepEqual(decodeContextString(encodeContextString(CTX)), CTX);
});

test('context propagation codec never throws on malformed input', (t) => {
  t.is(decodeContextString('not json'), undefined);
  t.is(decodeContextString(''), undefined);
  t.is(decodeContextString(undefined), undefined);
  // readContextHeader delegates to decodeContextPayload: a missing/absent header
  // yields undefined rather than throwing.
  t.is(readContextHeader(undefined), undefined);
  t.is(readContextHeader({}), undefined);
  t.is(decodeContextString('{"unrelated":true}'), undefined);
});

test('describeError renders a non-benign ApplicationFailure as "type: message"', (t) => {
  const err = ApplicationFailure.create({ message: 'boom', type: 'MyError' });
  t.is(describeError(err), 'MyError: boom');
});

test('describeError defaults the type to ApplicationError', (t) => {
  const err = ApplicationFailure.create({ message: 'boom' });
  t.is(describeError(err), 'ApplicationError: boom');
});

test('describeError suppresses BENIGN-category failures', (t) => {
  const err = ApplicationFailure.create({
    message: 'expected',
    type: 'Benign',
    category: ApplicationFailureCategory.BENIGN,
  });
  t.is(describeError(err), undefined);
});

test('describeError renders a plain Error and a non-error value', (t) => {
  t.is(describeError(new TypeError('nope')), 'TypeError: nope');
  t.is(describeError('raw'), 'raw');
});

test('run-name builders build the documented names', (t) => {
  t.is(startWorkflowRunName('W'), 'StartWorkflow:W');
  t.is(runWorkflowRunName('W'), 'RunWorkflow:W');
  t.is(startActivityRunName('a'), 'StartActivity:a');
  t.is(runActivityRunName('a'), 'RunActivity:a');
  t.is(startChildWorkflowRunName('C'), 'StartChildWorkflow:C');
  t.is(signalChildWorkflowRunName('s'), 'SignalChildWorkflow:s');
  t.is(signalExternalWorkflowRunName('s'), 'SignalExternalWorkflow:s');
  t.is(startNexusOperationRunName('Svc', 'op'), 'StartNexusOperation:Svc/op');
});

const run = (id: string, name: string, parent?: string): CollectedRun => ({ id, name, parent_run_id: parent });

test('dumpTraces renders a nested tree with two-space indent in insertion order', (t) => {
  const records = [run('1', 'root'), run('2', 'child-a', '1'), run('3', 'grandchild', '2'), run('4', 'child-b', '1')];
  t.is(dumpTraces(records), ['root', '  child-a', '    grandchild', '  child-b'].join('\n'));
});

test('dumpTraces de-duplicates repeated ids (replay collapses)', (t) => {
  const records = [run('1', 'root'), run('2', 'child', '1'), run('2', 'child', '1')];
  t.is(dumpTraces(records), ['root', '  child'].join('\n'));
});

test('dumpTraces throws on a dangling parent reference', (t) => {
  t.throws(() => dumpTraces([run('2', 'orphan', 'missing')]), { message: /dangling parent_run_id/ });
});

test('InMemoryRunCollector records create order and merges updates by id', async (t) => {
  const c = new InMemoryRunCollector();
  await c.createRun({ id: 'a', name: 'A', parent_run_id: undefined });
  await c.createRun({ id: 'b', name: 'B', parent_run_id: 'a' });
  await c.updateRun('b', { outputs: { ok: true } });
  t.deepEqual(c.createOrder, ['a', 'b']);
  t.deepEqual(c.byName('B')?.outputs, { ok: true });
  t.is(c.parentNameOf('B'), 'A');
  await c.awaitPendingTraceBatches();
  t.is(c.flushCount, 1);
  c.clear();
  t.deepEqual(c.records, []);
});
