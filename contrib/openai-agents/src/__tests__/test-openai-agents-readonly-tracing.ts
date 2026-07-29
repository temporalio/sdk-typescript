// Worker-based integration test for the read-only-handler tracing path.
//
// Query handlers and update validators are read-only, so their tracing-ID draws
// can't use the replay-seeded stream (it isn't persisted there and would replay-
// collide across separate read-only tasks). They draw from `unsafe.random`
// instead, so each evaluation gets a fresh span ID. This test issues the SAME
// Query and the SAME update-validation repeatedly against one live Workflow and
// asserts the emitted `temporal:handleQuery` / `temporal:validateUpdate` span IDs
// are well-formed AND distinct across evaluations.
//
// `maxCachedWorkflows: 0` forces every Query/update task to replay the full
// history from a fresh isolate, which re-seeds the body stream identically each
// time. So if the read-only path were wired to the seeded stream instead, the
// replayed handlers would re-derive the same span IDs every iteration AND
// collide across handlers (handleQuery and validateUpdate drawing the same id);
// the collector dedups by id and its name-collision guard rejects those clashes,
// leaving fewer than ITERATIONS distinct records and failing the assertions. That
// replay re-seeding is what gives this test teeth.
import { setTracingDisabled, withTrace } from '@openai/agents-core';
import { WorkflowClient } from '@temporalio/client';
import { helpers } from '@temporalio/test-helpers';
import { OpenAIAgentsPlugin, OpenAIAgentsTraceClientInterceptor } from '..';
import { FakeModelProvider } from './stubs/openai-agents';
import { installAgentSdkCollector } from './helpers/openai-agents-spans';
import { makeTestFunction } from './helpers/test-fn';
import {
  pingQuery,
  noopUpdate,
  finishSignal,
  readonlyTracingWorkflow,
} from './workflows/openai-agents-readonly-tracing';

// Upstream auto-disables agent-SDK tracing under NODE_ENV=test; opt back in.
setTracingDisabled(false);

const test = makeTestFunction({
  workflowsPath: require.resolve('./workflows/openai-agents-readonly-tracing'),
  workflowInterceptorModules: [require.resolve('@temporalio/openai-agents/workflow-interceptor')],
  plugins: [new OpenAIAgentsPlugin({ modelProvider: new FakeModelProvider([]) })],
});

const HEX24 = /^span_[0-9a-f]{24}$/;
const ITERATIONS = 5;

test('read-only handler tracing: repeated query/update-validation emit distinct, well-formed span ids', async (t) => {
  const { createWorker, taskQueue } = helpers(t);

  const agentSdk = installAgentSdkCollector();
  const worker = await createWorker({
    maxCachedWorkflows: 0,
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([]),
        interceptorOptions: { addTemporalSpans: true, useOtelInstrumentation: false },
      }),
    ],
  });

  // Inject `addTemporalSpans: true` into the start header so the worker emits
  // `temporal:*` spans for this execution.
  const wfClient = new WorkflowClient({
    connection: (t.context as any).env.connection,
    interceptors: [new OpenAIAgentsTraceClientInterceptor({ addTemporalSpans: true })],
  });

  try {
    await worker.runUntil(async () => {
      const handle = await wfClient.start(readonlyTracingWorkflow, {
        taskQueue,
        workflowId: `readonly-tracing-${Date.now()}`,
        workflowExecutionTimeout: '30 seconds',
      });

      // The client interceptor only injects the trace header (and so the worker
      // only emits `temporal:*` spans) when the call runs inside an agent-SDK trace.
      await withTrace('readonly-tracing-root', async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          t.is(await handle.query(pingQuery), 'pong');
          t.is(await handle.executeUpdate(noopUpdate, { args: [`v${i}`] }), `handled-v${i}`);
        }
      });

      await handle.signal(finishSignal);
      t.is(await handle.result(), 'done');
    });

    const queryRecords = agentSdk.collector.records_().filter((r) => r.name === 'temporal:handleQuery:ping');
    const validateRecords = agentSdk.collector
      .records_()
      .filter((r) => r.name === 'temporal:validateUpdate:noopUpdate');

    t.is(queryRecords.length, ITERATIONS, 'each query evaluation must emit a distinct handleQuery span');
    t.is(validateRecords.length, ITERATIONS, 'each update validation must emit a distinct validateUpdate span');

    for (const r of [...queryRecords, ...validateRecords]) {
      t.regex(r.id, HEX24);
      t.regex(r.traceId, /^trace_[0-9a-f]{32}$/);
    }

    t.is(new Set([...queryRecords, ...validateRecords].map((r) => r.id)).size, ITERATIONS * 2, 'all span ids distinct');
  } finally {
    await agentSdk.teardown();
  }
});
