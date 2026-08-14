/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Telemetry replay-safety. ADK creates OpenTelemetry spans (tracer
 * `gcp.vertex.agent`: `invocation`, `invoke_agent <name>`, `call_llm`, …)
 * inside the Workflow sandbox. Composing this plugin with the SDK's
 * `OpenTelemetryPlugin` exports them through the Worker's replay-gated span
 * sink — so with the Workflow cache disabled (every workflow task replays the
 * full history), each real operation must still export exactly one span.
 * Also pins the isolation property the gate rests on: without the
 * OpenTelemetry plugin, sandbox spans never reach a process-global provider.
 */

import path from 'node:path';

import test, { type ExecutionContext } from 'ava';
import { trace } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OpenTelemetryPlugin } from '@temporalio/interceptors-opentelemetry';

import { GoogleAdkPlugin } from '../index';
import { defaultTestProvider, setupTestEnv, uid, withWorker } from './helpers';
import { agentRunnerTwoTurnsWorkflow } from './workflows';

const getEnv = setupTestEnv(test);

function makeAdkPlugin(): GoogleAdkPlugin {
  return new GoogleAdkPlugin({ modelProvider: defaultTestProvider() });
}

/** Span-name → count for spans recorded by ADK's `gcp.vertex.agent` tracer. */
function adkSpanCounts(exporter: InMemorySpanExporter): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const span of exporter.getFinishedSpans()) {
    if (span.instrumentationLibrary.name !== 'gcp.vertex.agent') continue;
    counts[span.name] = (counts[span.name] ?? 0) + 1;
  }
  return counts;
}

/** `WorkflowTaskTimedOut`/`WorkflowTaskFailed` events — retried (not replayed) workflow tasks. */
function countWorkflowTaskRetries(
  events: Array<{ workflowTaskTimedOutEventAttributes?: unknown; workflowTaskFailedEventAttributes?: unknown }>
): number {
  return events.filter(
    (e) => e.workflowTaskTimedOutEventAttributes != null || e.workflowTaskFailedEventAttributes != null
  ).length;
}

/**
 * Asserts exactly `expected[name]` exported ADK spans per name. Callers must
 * pass an exporter produced by `scenarioWithRetryFreeHistory`, which
 * guarantees the history behind it has no workflow task retries — the one
 * event that legitimately re-emits spans (a retry re-executes live; see the
 * README's cautions). Keeping the assertion exact is the point of these
 * regression tests: an N+1 replay over-count must never pass.
 */
function assertAdkSpanCounts(
  t: ExecutionContext,
  exporter: InMemorySpanExporter,
  expected: Record<string, number>
): void {
  const counts = adkSpanCounts(exporter);
  for (const [name, n] of Object.entries(expected)) {
    t.is(counts[name], n, name);
  }
}

type HistoryEvents = Array<{
  workflowTaskTimedOutEventAttributes?: unknown;
  workflowTaskFailedEventAttributes?: unknown;
  workflowTaskStartedEventAttributes?: unknown;
  activityTaskScheduledEventAttributes?: unknown;
}>;

const MAX_SCENARIO_ATTEMPTS = 3;

/**
 * Runs `scenario` with a fresh exporter until the resulting history contains
 * no workflow task retries, so span-count assertions can always be exact. A
 * retry (task timeout/failure on a loaded CI runner) re-executes workflow
 * code live and legitimately re-emits spans; rather than weakening the
 * assertion to a lower bound — which would also let a genuine replay
 * over-count pass — the scenario is re-run on a fresh workflow.
 */
async function scenarioWithRetryFreeHistory(
  t: ExecutionContext,
  scenario: (exporter: InMemorySpanExporter) => Promise<HistoryEvents>
): Promise<{ exporter: InMemorySpanExporter; events: HistoryEvents }> {
  let retries = 0;
  for (let attempt = 1; attempt <= MAX_SCENARIO_ATTEMPTS; attempt++) {
    const exporter = new InMemorySpanExporter();
    const events = await scenario(exporter);
    retries = countWorkflowTaskRetries(events);
    if (retries === 0) {
      return { exporter, events };
    }
    t.log(
      `attempt ${attempt}/${MAX_SCENARIO_ATTEMPTS}: history has ${retries} workflow task ` +
        `retries, which re-emit spans live; re-running the scenario for exact-count assertions`
    );
  }
  throw new Error(
    `history still contained ${retries} workflow task retries after ` +
      `${MAX_SCENARIO_ATTEMPTS} attempts; environment too unstable for exact span-count assertions`
  );
}

// Composing with OpenTelemetryPlugin exports ADK spans; replays add none (E2E)
test.serial('adkSpansExportOncePerOperationUnderReplay', async (t) => {
  const env = getEnv();

  const { exporter, events } = await scenarioWithRetryFreeHistory(t, async (exporter) => {
    const taskQueue = uid('adk-otel');
    const workflowId = uid('wf-otel');
    const otelPlugin = new OpenTelemetryPlugin({
      resource: new Resource({ 'service.name': 'adk-telemetry-test' }),
      spanProcessor: new SimpleSpanProcessor(exporter),
    });

    // Observability plugins compose before this one (see README). The workflow
    // cache is disabled so every workflow task after the first replays the whole
    // history — re-running ADK's span-creating agent-loop code in the sandbox.
    const result = await withWorker(
      env,
      { taskQueue, plugins: [otelPlugin, makeAdkPlugin()], maxCachedWorkflows: 0 },
      () => env.client.workflow.execute(agentRunnerTwoTurnsWorkflow, { taskQueue, workflowId, args: ['hi'] })
    );
    t.is(result, 'fake-response:fake-model|fake-response:fake-model');

    return (await env.client.workflow.getHandle(workflowId).fetchHistory()).events ?? [];
  });

  const workflowTasks = events.filter((e) => e.workflowTaskStartedEventAttributes != null).length;
  const modelActivities = events.filter((e) => e.activityTaskScheduledEventAttributes != null).length;
  t.is(modelActivities, 2);
  t.true(workflowTasks >= 3, `expected >= 3 workflow tasks so replays occurred, got ${workflowTasks}`);

  // Exactly one exported span per real operation. A regression that lets
  // replayed sandbox code re-emit (e.g. a callDuringReplay sink) would show up
  // here as workflowTasks-proportional counts (3+ per name).
  assertAdkSpanCounts(t, exporter, {
    call_llm: 2,
    invocation: 2,
    'invoke_agent assistant': 2,
  });
});

// ADK evaluated before the interceptor factories still exports spans (E2E)
test.serial('adkSpansExportWhenAdkEvaluatesBeforeInterceptorFactories', async (t) => {
  const env = getEnv();

  const { exporter } = await scenarioWithRetryFreeHistory(t, async (exporter) => {
    const taskQueue = uid('adk-otel-early');
    const workflowId = uid('wf-otel-early');
    const otelPlugin = new OpenTelemetryPlugin({
      resource: new Resource({ 'service.name': 'adk-telemetry-test' }),
      spanProcessor: new SimpleSpanProcessor(exporter),
    });

    // A user workflow-interceptors module importing `@google/adk` evaluates ADK
    // — and its module-load `trace.getTracer(...)` — before any interceptor
    // factory registers the sandbox tracer provider. ADK's tracer must still
    // bind to that provider, which requires the bundle to hold a single
    // `@opentelemetry/api` copy: with two copies (ADK pins one exact version),
    // every ADK span is silently dropped while the interceptor's own spans keep
    // exporting.
    const result = await withWorker(
      env,
      {
        taskQueue,
        plugins: [otelPlugin, makeAdkPlugin()],
        maxCachedWorkflows: 0,
        workflowInterceptorModules: [path.resolve(__dirname, '../../src/__tests__/adk-first-interceptor.ts')],
      },
      () => env.client.workflow.execute(agentRunnerTwoTurnsWorkflow, { taskQueue, workflowId, args: ['hi'] })
    );
    t.is(result, 'fake-response:fake-model|fake-response:fake-model');

    return (await env.client.workflow.getHandle(workflowId).fetchHistory()).events ?? [];
  });

  assertAdkSpanCounts(t, exporter, {
    call_llm: 2,
    invocation: 2,
    'invoke_agent assistant': 2,
  });
});

// Without the OpenTelemetry plugin, sandbox spans never reach a process-global provider (E2E)
test.serial('adkSpansDoNotLeakToProcessGlobalProvider', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-otel-isolate');
  const workflowId = uid('wf-otel-isolate');

  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  t.true(trace.setGlobalTracerProvider(provider));
  try {
    const result = await withWorker(env, { taskQueue, plugins: [makeAdkPlugin()], maxCachedWorkflows: 0 }, () =>
      env.client.workflow.execute(agentRunnerTwoTurnsWorkflow, { taskQueue, workflowId, args: ['hi'] })
    );
    t.is(result, 'fake-response:fake-model|fake-response:fake-model');
    t.deepEqual(adkSpanCounts(exporter), {});
  } finally {
    trace.disable();
    await provider.shutdown();
  }
});
