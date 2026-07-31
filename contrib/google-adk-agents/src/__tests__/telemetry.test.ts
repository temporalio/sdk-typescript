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

import test from 'ava';
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
  const counts = adkSpanCounts(exporter);
  t.is(counts['call_llm'], 2);
  t.is(counts['invocation'], 2);
  t.is(counts['invoke_agent assistant'], 2);
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
