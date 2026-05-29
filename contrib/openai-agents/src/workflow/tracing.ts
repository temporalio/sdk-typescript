import { type AsyncLocalStorage as ALS } from 'node:async_hooks';
import {
  addTraceProcessor,
  getGlobalTraceProvider,
  setTracingContextStorage,
  setTracingIdGenerator,
} from '@openai/agents-core';
import { inWorkflowContext, uuid4 } from '@temporalio/workflow';
import { WorkflowAgentSinkProcessor } from './agent-sink-processor';

// Module-level idempotency flag — lives once per V8 isolate.
let processorRegistered = false;

// `generateTracingId` is registered once with the agent SDK's global
// tracing-ID generator, so it can't accept a per-Workflow random source
// as a parameter. Each interceptor entry point installs its own random
// source into this ALS for the duration of `next()`; `generateTracingId`
// then reads from whichever scope it was called within.
const AsyncLocalStorageCtor: new <T>() => ALS<T> = (globalThis as any).AsyncLocalStorage ?? class {};

const tracingRandomStorage = new AsyncLocalStorageCtor<() => number>();

export function runWithTracingRandom<T>(random: () => number, fn: () => T): T {
  return tracingRandomStorage.run(random, fn);
}

function getCurrentTracingRandom(): (() => number) | undefined {
  return tracingRandomStorage.getStore();
}

function generateTracingId(): string {
  const random = getCurrentTracingRandom();
  if (!random) {
    return uuid4().replace(/-/g, '');
  }
  const ho = (n: number, p: number) => n.toString(16).padStart(p, '0');
  const view = new DataView(new ArrayBuffer(16));
  view.setUint32(0, (random() * 0x100000000) >>> 0);
  view.setUint32(4, (random() * 0x100000000) >>> 0);
  view.setUint32(8, (random() * 0x100000000) >>> 0);
  view.setUint32(12, (random() * 0x100000000) >>> 0);
  return `${ho(view.getUint32(0), 8)}${ho(view.getUint32(4), 8)}${ho(view.getUint32(8), 8)}${ho(
    view.getUint32(12),
    8
  )}`;
}

/**
 * Registers the Workflow-side agent-SDK sink processor, installs a working
 * AsyncLocalStorage as the agent SDK's tracing-context storage, and wires the
 * Workflow-scoped tracing PRNG into the agent SDK's ID generator. Called from
 * the inbound interceptor's `execute` and from the runner constructor;
 * idempotent per V8 isolate.
 */
export function ensureTracingProcessorRegistered(): void {
  // The Workflow bundle picks @openai/agents-core's browser shim, which
  // defaults `tracing.disabled` to true → createSpan returns NoopSpans with
  // literal 'no-op' spanId, breaking the wire. Re-assert on every call so
  // callers downstream of a transient setDisabled(true) recover.
  getGlobalTraceProvider().setDisabled(false);

  if (processorRegistered) return;
  processorRegistered = true;

  if (inWorkflowContext()) {
    const ALSCtor = (globalThis as any).AsyncLocalStorage;
    if (ALSCtor) setTracingContextStorage(new ALSCtor());
  }

  setTracingIdGenerator({
    generateTraceId: () => `trace_${generateTracingId()}`,
    generateSpanId: () => `span_${generateTracingId().slice(0, 24)}`,
  });

  addTraceProcessor(new WorkflowAgentSinkProcessor());
}
