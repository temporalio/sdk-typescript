/**
 * Nexus inbound handler instrumentation (no Temporal server).
 *
 * Nexus headers cross the wire as a plain `Record<string, string>` (not Payload-
 * encoded), so the trace context travels as a JSON string. This drives the
 * Nexus inbound interceptor directly with a reconstructed parent header and
 * asserts:
 *  - `startOperation` opens a `RunStartNexusOperationHandler:` run nested under
 *    the propagated parent, and installs it as the active run for the handler
 *    body,
 *  - `cancelOperation` opens `RunCancelNexusOperationHandler:`,
 *  - with `addTemporalRuns: false` no handler run is emitted but the parent
 *    context is still installed for the body,
 *  - the plain-string carrier round-trips losslessly.
 *
 * @module
 */

process.env.LANGSMITH_TRACING = 'true';

import test from 'ava';
import { RunTree } from 'langsmith/run_trees';
import { getCurrentRunTree } from 'langsmith/traceable';

import { createNexusInboundInterceptor } from '../activity-interceptor';
import { HEADER_KEY, decodeContextString, encodeContextString } from '../propagation';
import type { EmitterConfig } from '../sinks';
import { InMemoryRunCollector } from './helpers';

type NexusHandler = (
  input: { service: string; operation: string; headers?: Record<string, string> },
  next: (input: unknown) => Promise<unknown>,
) => Promise<unknown>;

/** Build a parent run and the encoded Nexus header carrying its context. */
function parentAndHeader(collector: InMemoryRunCollector): { parent: RunTree; encoded: string } {
  const parent = new RunTree({
    name: 'user_root',
    run_type: 'chain',
    client: collector.asClient(),
    tracingEnabled: true,
  });
  return { parent, encoded: encodeContextString(parent.toHeaders() as never) };
}

test('Nexus inbound instrumentation (addTemporalRuns: true): opens a start-handler run nested under the propagated parent', async (t) => {
  const collector = new InMemoryRunCollector();
  const { parent, encoded } = parentAndHeader(collector);
  const ic = createNexusInboundInterceptor({
    client: collector.asClient() as never,
    addTemporalRuns: true,
  } as EmitterConfig) as unknown as { startOperation: NexusHandler };

  let innerId: string | undefined;
  await ic.startOperation(
    { service: 'NexusService', operation: 'run_operation', headers: { [HEADER_KEY]: encoded } },
    async () => {
      innerId = getCurrentRunTree(true)?.id;
      return { ok: true };
    },
  );

  const run = collector.byName('RunStartNexusOperationHandler:NexusService/run_operation');
  t.truthy(run);
  t.is(run?.run_type, 'chain');
  t.is(run?.parent_run_id, parent.id);
  // The handler body ran with the operation run as the active LangSmith run.
  t.is(innerId, run?.id);
});

test('Nexus inbound instrumentation (addTemporalRuns: true): opens a cancel-handler run for cancelOperation', async (t) => {
  const collector = new InMemoryRunCollector();
  const { encoded } = parentAndHeader(collector);
  const ic = createNexusInboundInterceptor({
    client: collector.asClient() as never,
    addTemporalRuns: true,
  } as EmitterConfig) as unknown as { cancelOperation: NexusHandler };

  await ic.cancelOperation(
    { service: 'NexusService', operation: 'run_operation', headers: { [HEADER_KEY]: encoded } },
    async () => undefined,
  );

  t.truthy(collector.byName('RunCancelNexusOperationHandler:NexusService/run_operation'));
});

test('Nexus inbound instrumentation (addTemporalRuns: false): installs the parent context for the body without emitting a handler run', async (t) => {
  const collector = new InMemoryRunCollector();
  const { parent, encoded } = parentAndHeader(collector);
  const ic = createNexusInboundInterceptor({
    client: collector.asClient() as never,
    addTemporalRuns: false,
  } as EmitterConfig) as unknown as { startOperation: NexusHandler };

  let innerId: string | undefined;
  await ic.startOperation(
    { service: 'NexusService', operation: 'run_operation', headers: { [HEADER_KEY]: encoded } },
    async () => {
      innerId = getCurrentRunTree(true)?.id;
      return undefined;
    },
  );

  t.is(collector.byName('RunStartNexusOperationHandler:NexusService/run_operation'), undefined);
  // Body still nests under the reconstructed parent.
  t.is(innerId, parent.id);
});

test('Nexus plain-string trace carrier: round-trips losslessly', (t) => {
  const collector = new InMemoryRunCollector();
  const ctx = new RunTree({ name: 'r', run_type: 'chain', client: collector.asClient() }).toHeaders();
  t.deepEqual(decodeContextString(encodeContextString(ctx as never)), ctx);
});
