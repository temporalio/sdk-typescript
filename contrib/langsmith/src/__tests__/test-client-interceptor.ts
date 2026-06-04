/**
 * Client-side interceptor unit coverage (no Temporal server).
 *
 * Drives {@link createClientInterceptor} directly with a fake `next` that
 * captures the outbound header map, all inside a user `traceable` so there is a
 * real ambient LangSmith run. Asserts:
 *  - every messaging/execution op emits its marker, parented under the ambient,
 *  - the trace header is injected on every traced op,
 *  - execution ops (`start`) propagate the *ambient* (so the remote run is a
 *    sibling of the marker), while messaging ops (`signal`) propagate the
 *    *marker* (so the remote handler nests under it),
 *  - lifecycle ops (`terminate`/`cancel`/`describe`) emit no run and no header,
 *  - with `addTemporalRuns: false` no marker is emitted but context still flows.
 *
 * @module
 */

process.env.LANGSMITH_TRACING = 'true';

import test from 'ava';
import { RunTree } from 'langsmith/run_trees';
import { getCurrentRunTree, traceable } from 'langsmith/traceable';

import { createClientInterceptor } from '../client-interceptor';
import { HEADER_KEY, readContextHeader } from '../propagation';
import type { EmitterConfig } from '../sinks';
import { InMemoryRunCollector } from './helpers';

/** The client interceptor methods this test drives, each as `(input, next) => Promise`. */
type InterceptorMethod = (input: unknown, next: (input: unknown) => Promise<unknown>) => Promise<unknown>;
type ClientInterceptorMethods = Record<
  | 'start'
  | 'signal'
  | 'signalWithStart'
  | 'query'
  | 'startUpdate'
  | 'startUpdateWithStart'
  | 'terminate'
  | 'cancel'
  | 'describe',
  InterceptorMethod
>;

/** Resolve the run id encoded into an outbound header's trace context. */
function propagatedId(headers: Record<string, unknown> | undefined): string | undefined {
  const ctx = readContextHeader(headers as never);
  if (!ctx) {
    return undefined;
  }
  return RunTree.fromHeaders(ctx as unknown as Record<string, string>)?.id;
}

test('client interceptor (addTemporalRuns: true): emits markers under the ambient run and injects trace headers', async (t) => {
  const collector = new InMemoryRunCollector();
  const config: EmitterConfig = { client: collector.asClient() as never, addTemporalRuns: true };
  const ic = createClientInterceptor(config) as unknown as ClientInterceptorMethods;

  const captured: Record<string, Record<string, unknown>> = {};
  const capture =
    (key: string) =>
    async (input: unknown): Promise<string> => {
      captured[key] = (input as { headers: Record<string, unknown> }).headers;
      return key;
    };
  const base = { headers: {}, args: ['x'] };

  const rootId = await traceable(
    async (): Promise<string> => {
      const id = getCurrentRunTree(true)!.id;
      await ic.start({ ...base, workflowType: 'W' }, capture('start'));
      await ic.signal({ ...base, signalName: 'go' }, capture('signal'));
      await ic.signalWithStart({ ...base, workflowType: 'W', signalName: 'go' }, capture('signalWithStart'));
      await ic.query({ ...base, queryName: 'q' }, capture('query'));
      await ic.startUpdate({ ...base, updateName: 'u' }, capture('startUpdate'));
      await ic.startUpdateWithStart({ ...base, updateName: 'u' }, capture('startUpdateWithStart'));
      await ic.terminate({ ...base }, capture('terminate'));
      await ic.cancel({ ...base }, capture('cancel'));
      await ic.describe({ ...base }, capture('describe'));
      return id;
    },
    { name: 'user_root', client: collector.asClient(), tracingEnabled: true },
  )();

  // Each traced op emitted exactly one marker, parented under the ambient root.
  const markerNames = [
    'StartWorkflow:W',
    'SignalWorkflow:go',
    'SignalWithStartWorkflow:W',
    'QueryWorkflow:q',
    'StartWorkflowUpdate:u',
    'StartUpdateWithStartWorkflow:u',
  ];
  for (const name of markerNames) {
    const run = collector.byName(name);
    t.truthy(run);
    t.is(run?.parent_run_id, rootId);
  }

  // Trace header injected on every traced op.
  for (const key of ['start', 'signal', 'signalWithStart', 'query', 'startUpdate', 'startUpdateWithStart']) {
    t.truthy(captured[key]?.[HEADER_KEY]);
  }

  // Execution op propagates the AMBIENT (sibling semantics for the remote run).
  t.is(propagatedId(captured.start), rootId);
  // Messaging op propagates the MARKER (the remote handler nests under it).
  t.is(propagatedId(captured.signal), collector.byName('SignalWorkflow:go')?.id);

  // Lifecycle ops: no run emitted, no header injected.
  t.is(collector.byName('TerminateWorkflow'), undefined);
  t.is(captured.terminate?.[HEADER_KEY], undefined);
  t.is(captured.cancel?.[HEADER_KEY], undefined);
  t.is(captured.describe?.[HEADER_KEY], undefined);
});

test('client interceptor (addTemporalRuns: false): propagates context but emits no marker run', async (t) => {
  const collector = new InMemoryRunCollector();
  const config: EmitterConfig = { client: collector.asClient() as never, addTemporalRuns: false };
  const ic = createClientInterceptor(config) as unknown as ClientInterceptorMethods;

  let startHeaders: Record<string, unknown> | undefined;
  const rootId = await traceable(
    async (): Promise<string> => {
      const id = getCurrentRunTree(true)!.id;
      await ic.start({ headers: {}, args: [], workflowType: 'W' }, async (input: unknown) => {
        startHeaders = (input as { headers: Record<string, unknown> }).headers;
        return 'wfid';
      });
      return id;
    },
    { name: 'user_root', client: collector.asClient(), tracingEnabled: true },
  )();

  t.is(collector.byName('StartWorkflow:W'), undefined);
  t.truthy(startHeaders?.[HEADER_KEY]);
  // The ambient context still flows so the remote run nests correctly.
  t.is(propagatedId(startHeaders), rootId);
});
