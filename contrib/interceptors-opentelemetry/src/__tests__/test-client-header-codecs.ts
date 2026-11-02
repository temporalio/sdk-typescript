import test from 'ava';
import * as otel from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { Resource } from '@opentelemetry/resources';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Client, type ConnectionLike, type WorkflowClientInterceptor } from '@temporalio/client';
import { defaultPayloadConverter, type PayloadCodec, type SerializationContext } from '@temporalio/common';
import type { temporal } from '@temporalio/proto';
import { OpenTelemetryPlugin } from '../plugin';

test.serial('client tracing codecs bind per client and leave user-provided headers unchanged', async (t) => {
  const span = { traceId: '12345678901234567890123456789012', spanId: '1234567890123456', traceFlags: 1 };
  const active = otel.trace.setSpanContext(otel.ROOT_CONTEXT, span);
  otel.propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  otel.context.setGlobalContextManager({
    active: () => active,
    with: (_context, fn, thisArg, ...args) => fn.call(thisArg, ...args),
    bind: (_context, target) => target,
    enable() {
      return this;
    },
    disable() {
      return this;
    },
  });
  try {
    for (const enabled of [false, true]) {
      const requests: temporal.api.workflowservice.v1.IStartWorkflowExecutionRequest[] = [];
      const calls: SerializationContext[] = [];
      let invalid = false;
      const codec = (marker: string): PayloadCodec => ({
        async encode(payloads, context) {
          for (const payload of payloads) {
            t.is(Buffer.from(payload.metadata!.encoding!).toString(), 'json/plain');
            calls.push(context!);
            payload.metadata!.codec = Buffer.from(marker);
          }
          return invalid ? [] : payloads;
        },
        async decode(payloads) {
          return payloads;
        },
      });
      const connection = {
        plugins: [],
        workflowService: {
          startWorkflowExecution: async (request: (typeof requests)[number]) => {
            requests.push(structuredClone(request));
            return { runId: 'run' };
          },
        },
      } as unknown as ConnectionLike;
      const raw = {
        metadata: { encoding: new TextEncoder().encode('binary/manual') },
        data: new Uint8Array([1, 2, 3]),
      };
      const existing = {
        workflow: [
          { start: (input, next) => next({ ...input, headers: { raw } }) } satisfies WorkflowClientInterceptor,
        ],
      };
      const plugin = new OpenTelemetryPlugin({
        resource: new Resource({}),
        spanProcessor: new SimpleSpanProcessor(new InMemorySpanExporter()),
        encodeClientHeaders: enabled,
      });
      const first = new Client({
        connection,
        namespace: 'first',
        plugins: [plugin],
        interceptors: existing,
        dataConverter: { payloadCodecs: [codec('first')] },
      });
      const second = new Client({
        connection,
        namespace: 'second',
        plugins: [plugin],
        interceptors: existing,
        dataConverter: { payloadCodecs: [codec('second')] },
      });
      const workerOptions = plugin.configureWorker({
        taskQueue: 'queue',
        namespace: 'worker',
        dataConverter: { payloadCodecs: [codec('worker')] },
        interceptors: { client: existing },
      });
      const workerClient = new Client({
        connection,
        namespace: workerOptions.namespace,
        dataConverter: workerOptions.dataConverter,
        interceptors: workerOptions.interceptors!.client,
      });
      for (const [index, client] of [first, second, workerClient, first].entries()) {
        await client.workflow.start('workflow', { taskQueue: 'queue', workflowId: `wf-${index}` });
      }
      t.deepEqual(
        calls,
        enabled
          ? ['first', 'second', 'worker', 'first'].map((namespace, index) => ({
              type: 'workflow',
              namespace,
              workflowId: `wf-${index}`,
            }))
          : []
      );
      for (const [index, request] of requests.entries()) {
        t.deepEqual(request.header!.fields!.raw, raw);
        const trace = request.header!.fields!['_tracer-data']!;
        t.is(
          trace.metadata?.codec && Buffer.from(trace.metadata.codec).toString(),
          enabled ? ['first', 'second', 'worker', 'first'][index] : undefined
        );
        t.truthy(defaultPayloadConverter.fromPayload<{ traceparent: string }>(trace).traceparent);
      }
      if (enabled) {
        invalid = true;
        await t.throwsAsync(first.workflow.start('workflow', { taskQueue: 'queue', workflowId: 'invalid' }), {
          message: 'Tracing header codec must return exactly one payload, got 0',
        });
        t.is(requests.length, 4);
      }
    }
  } finally {
    otel.context.disable();
    otel.propagation.disable();
  }
});
