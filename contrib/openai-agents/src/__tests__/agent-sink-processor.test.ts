import test from 'ava';
import type { Span as AgentSpan, SpanData } from '@openai/agents-core';
import { setActivator } from '@temporalio/workflow/lib/global-attributes';
import type { SinkCall } from '@temporalio/workflow/lib/sinks';
import { WorkflowAgentSinkProcessor, flushOpenSpans } from '../workflow/agent-sink-processor';

interface StubActivator {
  info: {
    workflowId: string;
    runId: string;
    unsafe: { isReplayingHistoryEvents: boolean };
  };
  sinkCalls: SinkCall[];
}

async function withStubActivator<T>(stub: StubActivator, fn: () => Promise<T>): Promise<T> {
  setActivator(stub as any);
  try {
    return await fn();
  } finally {
    setActivator(undefined);
  }
}

test.serial('flushOpenSpans dispatches span_complete for unended spans and clears the workflow entry', async (t) => {
  const stub: StubActivator = {
    info: {
      workflowId: 'wf-orphan',
      runId: 'run-orphan',
      unsafe: { isReplayingHistoryEvents: false },
    },
    sinkCalls: [],
  };

  const span = {
    spanId: 'span_orphan_aaaaaaaaaaaaaa',
    traceId: 'trace_orphan_bbbbbbbbbbbbbbbbbbbb',
    parentId: null,
    spanData: { type: 'custom', name: 'orphan', data: {} },
    error: null,
  } as unknown as AgentSpan<SpanData>;

  const processor = new WorkflowAgentSinkProcessor();

  await withStubActivator(stub, async () => {
    await processor.onSpanStart(span);
    t.is(stub.sinkCalls.length, 1, 'onSpanStart must dispatch exactly one span_started');
    const startCall = stub.sinkCalls[0]!;
    t.is(startCall.ifaceName, 'agentTracing');
    t.is(startCall.fnName, 'dispatch');
    const startEvent = startCall.args[0] as {
      kind: string;
      span: { spanId: string; endedAt: string | null };
      forwardToOtel: boolean;
    };
    t.is(startEvent.kind, 'span_started');
    t.is(startEvent.span.spanId, 'span_orphan_aaaaaaaaaaaaaa');
    t.is(startEvent.span.endedAt, null);
    t.false(startEvent.forwardToOtel);
    await flushOpenSpans();
  });

  t.is(stub.sinkCalls.length, 2, 'flushOpenSpans must dispatch exactly one span_complete after the span_started');
  const call = stub.sinkCalls[1]!;
  t.is(call.ifaceName, 'agentTracing');
  t.is(call.fnName, 'dispatch');
  const event = call.args[0] as { kind: string; span: { spanId: string }; forwardToOtel: boolean };
  t.is(event.kind, 'span_complete');
  t.is(event.span.spanId, 'span_orphan_aaaaaaaaaaaaaa');
  t.false(event.forwardToOtel);

  // Second flush proves the open-span entry was cleared.
  await withStubActivator(stub, async () => {
    await flushOpenSpans();
  });
  t.is(stub.sinkCalls.length, 2, 'second flushOpenSpans must not re-dispatch');
});
