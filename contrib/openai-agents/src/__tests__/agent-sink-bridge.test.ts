import test from 'ava';
import * as otel from '@opentelemetry/api';
import {
  setTraceProcessors,
  getGlobalTraceProvider,
  type TracingProcessor,
  type Span as AgentSpan,
  type Trace as AgentTrace,
  type SpanData,
} from '@openai/agents-core';
import { isSuppressOtelBridge, markSuppressOtelBridge, makeAgentTracingSink } from '../worker/agent-sink-bridge';
import { ActivityTracingProcessor } from '../worker/activity-tracing';
import type { SerializedAgentSpan } from '../common/agent-sink-types';

// Sink-bridge tests mutate upstream's global TracerProvider and processor list,
// so they must run serially.

function findSuppressionSymbol(obj: object): symbol | undefined {
  return Object.getOwnPropertySymbols(obj).find(
    (s) => s.description === '@temporalio/openai-agents/suppress-otel-bridge'
  );
}

test.serial('markSuppressOtelBridge / isSuppressOtelBridge round-trip', (t) => {
  const marked = {} as AgentSpan<SpanData>;
  const unmarked = {} as AgentSpan<SpanData>;
  markSuppressOtelBridge(marked);

  t.true(isSuppressOtelBridge(marked));
  t.false(isSuppressOtelBridge(unmarked));

  const sym = findSuppressionSymbol(marked);
  t.truthy(sym, 'suppression symbol must be present on marked object');
  const descriptor = Object.getOwnPropertyDescriptor(marked, sym!);
  t.truthy(descriptor);
  t.false(descriptor!.enumerable, 'descriptor must be non-enumerable');
  t.false(descriptor!.writable, 'descriptor must be non-writable');
  t.false(descriptor!.configurable, 'descriptor must be non-configurable');
});

test.serial('bridge constructs spans with suppression marker when forwardToOtel is false', async (t) => {
  // Reset upstream processor list so we have a clean recorder.
  const recorded: Array<{ phase: 'start' | 'end'; suppressed: boolean }> = [];
  const recorder: TracingProcessor = {
    onTraceStart: async (trace: AgentTrace) => {
      recorded.push({ phase: 'start', suppressed: isSuppressOtelBridge(trace) });
    },
    onTraceEnd: async (trace: AgentTrace) => {
      recorded.push({ phase: 'end', suppressed: isSuppressOtelBridge(trace) });
    },
    onSpanStart: async (span: AgentSpan<SpanData>) => {
      recorded.push({ phase: 'start', suppressed: isSuppressOtelBridge(span) });
    },
    onSpanEnd: async (span: AgentSpan<SpanData>) => {
      recorded.push({ phase: 'end', suppressed: isSuppressOtelBridge(span) });
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };

  setTraceProcessors([recorder]);
  getGlobalTraceProvider().setDisabled(false);

  try {
    const sink = makeAgentTracingSink();

    const serializedSpan: SerializedAgentSpan = {
      type: 'trace.span',
      spanId: 'span_aaaaaaaaaaaaaaaa',
      traceId: 'trace_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      parentId: null,
      spanData: { type: 'custom', name: 'unit-test', data: {} },
      error: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:00.001Z',
    };

    recorded.length = 0;
    await sink.dispatch.fn({} as any, { kind: 'span_complete', span: serializedSpan, forwardToOtel: false });
    t.true(
      recorded.length > 0 && recorded.every((r) => r.suppressed),
      'span dispatched with forwardToOtel=false must carry suppression marker'
    );

    recorded.length = 0;
    await sink.dispatch.fn({} as any, { kind: 'span_complete', span: serializedSpan, forwardToOtel: true });
    t.true(
      recorded.length > 0 && recorded.every((r) => !r.suppressed),
      'span dispatched with forwardToOtel=true must not carry suppression marker'
    );
  } finally {
    setTraceProcessors([]);
  }
});

test.serial('bridge dispatches span_started through onSpanStart with synthesized Span fields', async (t) => {
  const recorded: Array<{ phase: 'start' | 'end'; suppressed: boolean; span: AgentSpan<SpanData> }> = [];
  const recorder: TracingProcessor = {
    onTraceStart: async () => {},
    onTraceEnd: async () => {},
    onSpanStart: async (span: AgentSpan<SpanData>) => {
      recorded.push({ phase: 'start', suppressed: isSuppressOtelBridge(span), span });
    },
    onSpanEnd: async (span: AgentSpan<SpanData>) => {
      recorded.push({ phase: 'end', suppressed: isSuppressOtelBridge(span), span });
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };

  setTraceProcessors([recorder]);
  getGlobalTraceProvider().setDisabled(false);

  try {
    const sink = makeAgentTracingSink();

    const serializedSpan: SerializedAgentSpan = {
      type: 'trace.span',
      spanId: 'span_started_aaaaaaaa',
      traceId: 'trace_started_bbbbbbbbbbbbbbbbbbbb',
      parentId: 'span_parent_cccccccc',
      spanData: { type: 'custom', name: 'unit-test-start', data: {} },
      error: null,
      startedAt: '2026-01-02T03:04:05.006Z',
      endedAt: null,
    };

    recorded.length = 0;
    await sink.dispatch.fn({} as any, { kind: 'span_started', span: serializedSpan, forwardToOtel: false });
    t.is(recorded.length, 1, 'span_started must trigger exactly one processor callback');
    const entry = recorded[0]!;
    t.is(entry.phase, 'start', 'span_started must invoke onSpanStart, not onSpanEnd');
    t.is(entry.span.spanId, 'span_started_aaaaaaaa');
    t.is(entry.span.parentId, 'span_parent_cccccccc');
    t.is(entry.span.startedAt, '2026-01-02T03:04:05.006Z');
    t.true(entry.suppressed, 'span_started with forwardToOtel=false must carry suppression marker');

    recorded.length = 0;
    await sink.dispatch.fn({} as any, { kind: 'span_started', span: serializedSpan, forwardToOtel: true });
    t.is(recorded.length, 1);
    t.is(recorded[0]!.phase, 'start');
    t.false(recorded[0]!.suppressed, 'span_started with forwardToOtel=true must not carry suppression marker');
  } finally {
    setTraceProcessors([]);
  }
});

test.serial(
  'ActivityTracingProcessor.onSpanStart/onSpanEnd short-circuit when SUPPRESS_OTEL_BRIDGE marker present',
  async (t) => {
    let startSpanCallCount = 0;
    const stubSpan: otel.Span = {
      setAttribute: () => stubSpan,
      setAttributes: () => stubSpan,
      addEvent: () => stubSpan,
      addLink: () => stubSpan,
      addLinks: () => stubSpan,
      setStatus: () => stubSpan,
      updateName: () => stubSpan,
      end: () => {},
      isRecording: () => true,
      recordException: () => {},
      spanContext: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 1 }),
    } as unknown as otel.Span;

    const stubTracer = {
      startSpan: (..._args: unknown[]): otel.Span => {
        startSpanCallCount++;
        return stubSpan;
      },
      startActiveSpan: ((_name: unknown, _opts: unknown, _ctx: unknown, fn: any) => {
        startSpanCallCount++;
        return fn(stubSpan);
      }) as otel.Tracer['startActiveSpan'],
    } as unknown as otel.Tracer;

    const stubProvider = {
      getTracer: () => stubTracer,
    } as unknown as otel.TracerProvider;

    otel.trace.setGlobalTracerProvider(stubProvider);

    try {
      const processor = new ActivityTracingProcessor();

      const markedSpan = {
        spanId: 'span_cafecafecafecafe',
        traceId: 'trace_deadbeefdeadbeefdeadbeefdeadbeef',
        parentId: null,
        spanData: { type: 'custom', name: 'suppressed', data: {} },
        error: null,
      } as unknown as AgentSpan<SpanData>;
      markSuppressOtelBridge(markedSpan);

      startSpanCallCount = 0;
      await processor.onSpanStart(markedSpan);
      await processor.onSpanEnd(markedSpan);
      t.is(startSpanCallCount, 0, 'marked span must not trigger startSpan on the OTel tracer');

      const unmarkedSpan = {
        spanId: 'span_1234567890abcdef',
        traceId: 'trace_aaaabbbbccccddddeeeeffff00001111',
        parentId: null,
        spanData: { type: 'custom', name: 'forwarded', data: {} },
        error: null,
      } as unknown as AgentSpan<SpanData>;

      startSpanCallCount = 0;
      await processor.onSpanStart(unmarkedSpan);
      t.true(startSpanCallCount > 0, 'unmarked span must trigger startSpan on the OTel tracer');
    } finally {
      otel.trace.disable();
    }
  }
);
