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
 * Asserts exactly `expected[name]` exported ADK spans per name on a clean
 * history. A workflow task retry (timeout/failure) is not a replay — the
 * retried segment's spans legitimately re-emit (see README) — so when a slow
 * runner caused retries, degrade to a lower bound, which still fails on
 * silently dropped spans.
 */
function assertAdkSpanCounts(
  t: ExecutionContext,
  exporter: InMemorySpanExporter,
  workflowTaskRetries: number,
  expected: Record<string, number>
): void {
  const counts = adkSpanCounts(exporter);
  for (const [name, n] of Object.entries(expected)) {
    if (workflowTaskRetries === 0) {
      t.is(counts[name], n, name);
    } else {
      t.true(
        (counts[name] ?? 0) >= n,
        `${name}: expected >= ${n} spans, got ${
          counts[name] ?? 0
        } (history has ${workflowTaskRetries} workflow task retries)`
      );
    }
  }
}

// Composing with OpenTelemetryPlugin exports ADK spans; replays add none (E2E)
test.serial('adkSpansExportOncePerOperationUnderReplay', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-otel');
  const workflowId = uid('wf-otel');

  const exporter = new InMemorySpanExporter();
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

  const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
  const events = history.events ?? [];
  const workflowTasks = events.filter((e) => e.workflowTaskStartedEventAttributes).length;
  const modelActivities = events.filter((e) => e.activityTaskScheduledEventAttributes).length;
  t.is(modelActivities, 2);
  t.true(workflowTasks >= 3, `expected >= 3 workflow tasks so replays occurred, got ${workflowTasks}`);

  // Exactly one exported span per real operation. A regression that lets
  // replayed sandbox code re-emit (e.g. a callDuringReplay sink) would show up
  // here as workflowTasks-proportional counts (3+ per name).
  assertAdkSpanCounts(t, exporter, countWorkflowTaskRetries(events), {
    call_llm: 2,
    invocation: 2,
    'invoke_agent assistant': 2,
  });
});

// ADK evaluated before the interceptor factories still exports spans (E2E)
test.serial('adkSpansExportWhenAdkEvaluatesBeforeInterceptorFactories', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-otel-early');
  const workflowId = uid('wf-otel-early');

  const exporter = new InMemorySpanExporter();
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

  const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
  assertAdkSpanCounts(t, exporter, countWorkflowTaskRetries(events ?? []), {
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
