/**
 * Test helpers for capturing and asserting on the OpenAI Agents trace tree.
 *
 * Two parallel capture streams are exposed:
 *
 *   - `OtelSpanCollector`: an OTel `SpanProcessor` that records every span
 *     emitted via the global `TracerProvider`. Used to assert the OTel tree
 *     when `useOtelInstrumentation: true`.
 *   - `AgentSdkSpanCollector`: an agent-SDK `TracingProcessor` that records
 *     every trace/span the agent SDK emits. Used to assert the agent-SDK
 *     stream independently of OTel.
 *
 * Both collectors expose `dumpTraces()` which returns the same indented-list
 * structure as the Python langsmith helper:
 *
 *     [
 *       ['user_pipeline', '  temporal:startWorkflow:foo', '  temporal:runWorkflow:foo', ...],
 *       ['temporal:queryWorkflow:bar', '  temporal:handleQuery:bar'],
 *     ]
 *
 * Each top-level list element is one root trace. Children indented with
 * two-space prefixes per depth, in emission order. Spans whose parent isn't
 * present in the collection are treated as roots — this naturally produces
 * separate traces for each Temporal-RPC entry point (start, signal, query,
 * update) when the test driver does NOT wrap them in an outer user span.
 *
 * `findTraces(traces, rootName)` filters by exact root name match.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import * as otelApi from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { addTraceProcessor, getGlobalTraceProvider, type TracingProcessor } from '@openai/agents-core';
import { createTracerProvider } from '../../otel';

// --------------------------------------------------------------------------
// Host-side OTel ContextManager
// --------------------------------------------------------------------------

/**
 * Minimal AsyncLocalStorage-backed OTel `ContextManager` used to propagate
 * the active OTel context across asynchronous boundaries in the host (test
 * driver) process. Without a registered context manager,
 * `tracer.startActiveSpan(...)`'s callback sees the active context only
 * synchronously — any `await` inside the callback loses the active span and
 * subsequent `startActiveSpan` calls produce root spans rather than children.
 *
 * Mirrors the pattern in
 * `packages/interceptors-opentelemetry/src/workflow/context-manager.ts`,
 * adapted for Node's `async_hooks.AsyncLocalStorage` directly (no shim).
 */
class HostContextManager implements otelApi.ContextManager {
  private storage = new AsyncLocalStorage<otelApi.Context>();

  active(): otelApi.Context {
    return this.storage.getStore() ?? otelApi.ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: otelApi.Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const cb = thisArg == null ? fn : fn.bind(thisArg);
    return this.storage.run(context, cb, ...args);
  }

  bind<T>(context: otelApi.Context, target: T): T {
    if (typeof target !== 'function') {
      throw new TypeError(`Only function binding is supported, got ${typeof target}`);
    }
    const wrapper = (...args: unknown[]) => this.with(context, () => (target as any).apply(this, args));
    Object.defineProperty(wrapper, 'length', {
      enumerable: false,
      configurable: true,
      writable: false,
      value: (target as any).length,
    });
    return wrapper as any;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.storage.disable();
    return this;
  }
}

// --------------------------------------------------------------------------
// Common types
// --------------------------------------------------------------------------

interface SpanRecord {
  id: string;
  parentId: string | undefined;
  name: string;
  traceId: string;
}

// --------------------------------------------------------------------------
// OTel collector
// --------------------------------------------------------------------------

/**
 * Minimal `SpanProcessor` shape we depend on. We avoid importing the full
 * `@opentelemetry/sdk-trace-base` types here to keep this file dependency-light;
 * the real SpanProcessor interface is satisfied structurally.
 */
export interface OtelReadableSpan {
  name: string;
  spanContext(): { spanId: string; traceId: string };
  parentSpanContext?: { spanId: string } | undefined;
  /** Older OTel versions expose `parentSpanId` directly on ReadableSpan. */
  parentSpanId?: string;
}

export interface OtelSpanProcessor {
  onStart(span: OtelReadableSpan, parentContext: unknown): void;
  onEnd(span: OtelReadableSpan): void;
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
}

export class OtelSpanCollector implements OtelSpanProcessor {
  private records: SpanRecord[] = [];
  private byId = new Map<string, SpanRecord>();

  onStart(span: OtelReadableSpan, _parentContext: unknown): void {
    const id = span.spanContext().spanId;
    const traceId = span.spanContext().traceId;
    const parentId = span.parentSpanContext?.spanId ?? span.parentSpanId ?? undefined;
    // Dedup by spanId. Deterministic tracingRandom + replayed handlers in mixed
    // activations (see plugin docs / replay discussion) means the SAME logical
    // span may be emitted by multiple worker activations with identical span
    // IDs. OTel spec requires span IDs to be unique within a trace, and
    // well-behaved backends dedup by (traceId, spanId); the test collector
    // simulates that contract to keep assertions stable under replay.
    const existing = this.byId.get(id);
    if (existing) {
      if (existing.name !== span.name) {
        throw new Error(`OTel spanId collision: spanId=${id} stored="${existing.name}" incoming="${span.name}"`);
      }
      return;
    }
    const record: SpanRecord = {
      id,
      parentId: parentId && parentId !== '0000000000000000' ? parentId : undefined,
      name: span.name,
      traceId,
    };
    this.byId.set(id, record);
    this.records.push(record);
  }

  // Refresh the captured name from the latest span.name. Some span types
  // (notably `handoff`) populate fields like `to_agent` AFTER `start()` has
  // fired; the base bridge processor calls `updateName` on the OTel span at
  // its onSpanEnd, so reading `span.name` here picks up the final value.
  onEnd(span: OtelReadableSpan): void {
    const record = this.byId.get(span.spanContext().spanId);
    if (record) record.name = span.name;
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  clear(): void {
    this.records = [];
    this.byId.clear();
  }

  /** All captured records, in emission order. */
  records_(): readonly SpanRecord[] {
    return this.records;
  }

  /** See {@link dumpTraces} module function. */
  dumpTraces(): string[][] {
    return dumpTraces(this.records);
  }
}

// --------------------------------------------------------------------------
// Agent-SDK collector
// --------------------------------------------------------------------------

/**
 * Minimal agent-SDK Trace / Span shapes. Matches the public surface of
 * `@openai/agents-core`'s `TracingProcessor`. We avoid importing those types
 * directly so this helper compiles without the agent-SDK installed.
 */
export interface AgentSdkSpan {
  spanId: string;
  parentId?: string;
  traceId: string;
  /** Agent SDK exposes name via `spanData.type` plus a discriminant field. */
  spanData: { type: string; name?: string; from_agent?: string; to_agent?: string };
}

export interface AgentSdkTrace {
  traceId: string;
  name: string;
}

/**
 * Implements the agent-SDK `TracingProcessor` interface structurally.
 *
 * The agent-SDK trace itself becomes a synthetic root in the captured stream
 * (its `traceId` is used as the synthetic root's id, and per-trace spans
 * point at it via their `traceId` as their parent when no explicit
 * `parentId` is set).
 */
export class AgentSdkSpanCollector {
  private records: SpanRecord[] = [];
  private byId = new Map<string, SpanRecord>();
  private traceIdToRootId = new Map<string, string>();

  onTraceStart(trace: AgentSdkTrace): void {
    const rootId = `trace:${trace.traceId}`;
    if (this.byId.has(rootId)) return;
    this.traceIdToRootId.set(trace.traceId, rootId);
    const record: SpanRecord = {
      id: rootId,
      parentId: undefined,
      name: trace.name,
      traceId: trace.traceId,
    };
    this.byId.set(rootId, record);
    this.records.push(record);
  }

  onTraceEnd(_trace: AgentSdkTrace): void {}

  onSpanStart(span: AgentSdkSpan): void {
    // Dedup by spanId — see OtelSpanCollector.onStart for the rationale.
    const incomingName = nameForAgentSdkSpan(span);
    const existing = this.byId.get(span.spanId);
    if (existing) {
      if (existing.name !== incomingName) {
        throw new Error(
          `AgentSdk spanId collision: spanId=${span.spanId} stored="${existing.name}" incoming="${incomingName}"`
        );
      }
      return;
    }
    const synthRoot = this.traceIdToRootId.get(span.traceId);
    const parentId = span.parentId ?? synthRoot;
    const record: SpanRecord = {
      id: span.spanId,
      parentId,
      name: incomingName,
      traceId: span.traceId,
    };
    this.byId.set(span.spanId, record);
    this.records.push(record);
  }

  onSpanEnd(span: AgentSdkSpan): void {
    // Re-derive the name at end. Some span types (notably `handoff`)
    // populate fields like `to_agent` AFTER `start()` fires, so the
    // start-time name reads `unknown`. Refresh in-place.
    const record = this.byId.get(span.spanId);
    if (record) record.name = nameForAgentSdkSpan(span);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  clear(): void {
    this.records = [];
    this.byId.clear();
    this.traceIdToRootId.clear();
  }

  records_(): readonly SpanRecord[] {
    return this.records;
  }

  dumpTraces(): string[][] {
    return dumpTraces(this.records);
  }
}

function nameForAgentSdkSpan(span: AgentSdkSpan): string {
  const d = span.spanData;
  switch (d.type) {
    case 'agent':
      return `agent:${d.name}`;
    case 'function':
      return `function:${d.name}`;
    case 'generation':
      return 'generation';
    case 'response':
      return 'response';
    case 'handoff':
      return `handoff:${d.from_agent ?? 'unknown'}->${d.to_agent ?? 'unknown'}`;
    case 'guardrail':
      return `guardrail:${d.name}`;
    case 'custom':
      // Custom spans carry their full name in `data.name` — includes the
      // `temporal:*` / `mcp:*` / `user_*` literals.
      return d.name ?? 'custom';
    case 'transcription':
      return 'transcription';
    case 'speech':
      return 'speech';
    case 'speech_group':
      return 'speech_group';
    case 'mcp_tools':
      return 'mcp_tools';
    default:
      return d.name ? `${d.type}:${d.name}` : d.type;
  }
}

// --------------------------------------------------------------------------
// Tree builder + indented renderer (shared)
// --------------------------------------------------------------------------

/**
 * Build root-grouped indented-list traces from a flat span record list.
 *
 * Spans are grouped by their *root ancestor*. A span is a root when its
 * `parentId` is `undefined` OR points at a span not present in the
 * collection (e.g., a `temporal:queryWorkflow:foo` emitted without an outer
 * user span is its own root).
 *
 * Children of a given parent appear in emission order. Within each trace,
 * the root appears first followed by its descendants in depth-first
 * traversal.
 *
 * Indentation: two spaces per depth level.
 */
export function dumpTraces(records: readonly SpanRecord[]): string[][] {
  const byId = new Map<string, SpanRecord>();
  for (const r of records) byId.set(r.id, r);

  const children = new Map<string | undefined, SpanRecord[]>();
  for (const r of records) {
    const effectiveParent = r.parentId !== undefined && byId.has(r.parentId) ? r.parentId : undefined;
    const arr = children.get(effectiveParent) ?? [];
    arr.push(r);
    children.set(effectiveParent, arr);
  }

  const traces: string[][] = [];
  for (const root of children.get(undefined) ?? []) {
    const trace: string[] = [root.name];
    walk(root.id, 1, trace, children);
    traces.push(trace);
  }
  return traces;
}

function walk(parentId: string, depth: number, out: string[], children: Map<string | undefined, SpanRecord[]>): void {
  for (const child of children.get(parentId) ?? []) {
    out.push('  '.repeat(depth) + child.name);
    walk(child.id, depth + 1, out, children);
  }
}

/** Flatten all traces in emission order. */
export function dumpRuns(records: readonly SpanRecord[]): string[] {
  return dumpTraces(records).flat();
}

/** Filter traces by exact root-line match. */
export function findTraces(traces: readonly string[][], rootName: string): string[][] {
  return traces.filter((t) => t.length > 0 && t[0] === rootName);
}

// --------------------------------------------------------------------------
// OTel TracerProvider helpers
// --------------------------------------------------------------------------

export interface OtelCollectorInstallation {
  readonly collector: OtelSpanCollector;
  dumpTraces(): string[][];
  teardown(): Promise<void>;
}

export interface AgentSdkCollectorInstallation {
  readonly collector: AgentSdkSpanCollector;
  dumpTraces(): string[][];
  teardown(): Promise<void>;
}

/**
 * Install a fresh `BasicTracerProvider` as the global OTel `TracerProvider`
 * with an `OtelSpanCollector` attached. On teardown, shuts the provider down
 * and disables the global OTel tracer so a subsequent test starts clean.
 */
export function installOtelCollector(): OtelCollectorInstallation {
  const collector = new OtelSpanCollector();
  const provider = createTracerProvider();
  provider.addSpanProcessor(collector);
  // Register the AsyncLocalStorage-backed context manager BEFORE setting the
  // global tracer provider so that `tracer.startActiveSpan(...)` propagates
  // context across awaits. Without this, the host-side `test_root`,
  // `user_pipeline`, etc. become OTel roots rather than nesting under
  // `test_root`.
  const contextManager = new HostContextManager();
  otelApi.context.setGlobalContextManager(contextManager);
  otelApi.propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  otelApi.trace.setGlobalTracerProvider(provider as unknown as otelApi.TracerProvider);
  return {
    collector,
    dumpTraces: () => collector.dumpTraces(),
    teardown: async () => {
      await provider.shutdown();
      otelApi.trace.disable();
      otelApi.context.disable();
      otelApi.propagation.disable();
      collector.clear();
    },
  };
}

/** Register an `AgentSdkSpanCollector` as an agent-SDK `TracingProcessor`. */
export function installAgentSdkCollector(): AgentSdkCollectorInstallation {
  // ava sets NODE_ENV=test, which makes `@openai/agents-core`'s config disable
  // tracing by default — every `createTrace`/`createSpan` returns a Noop that
  // dispatches to no processors. Force the global provider on so the collector
  // (and the plugin's host-side mirror) actually receive trace events.
  getGlobalTraceProvider().setDisabled(false);
  const collector = new AgentSdkSpanCollector();
  addTraceProcessor(collector as unknown as TracingProcessor);
  return {
    collector,
    dumpTraces: () => collector.dumpTraces(),
    teardown: async () => {
      collector.clear();
    },
  };
}
