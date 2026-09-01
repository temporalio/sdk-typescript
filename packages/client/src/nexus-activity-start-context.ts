import { AsyncLocalStorage } from 'node:async_hooks';
import type { temporal } from '@temporalio/proto';

/**
 * Ambient context set by `@temporalio/worker` for the duration of a Nexus `startOperation` handler
 * invocation, giving `ActivityClient` access to Nexus request data for raw Activity starts made
 * during that invocation.
 *
 * @internal
 * @hidden
 */
export interface NexusActivityStartContext {
  /** The Nexus request's ID (never empty). */
  readonly requestId: string;

  /** Inbound links of the Nexus request currently being handled. */
  readonly links: temporal.api.common.v1.ILink[];

  /** Records a response link returned by an Activity start made during this invocation. */
  pushResponseLink(link: temporal.api.common.v1.ILink): void;
}

// Make it safe to use this module with multiple installed copies of @temporalio/client, mirroring
// the pattern used by packages/nexus/src/context.ts for its own AsyncLocalStorage.
const asyncLocalStorageSymbol = Symbol.for('__temporal_nexus_activity_start_context_storage__');
if (!(globalThis as any)[asyncLocalStorageSymbol]) {
  (globalThis as any)[asyncLocalStorageSymbol] = new AsyncLocalStorage<NexusActivityStartContext>();
}
const asyncLocalStorage: AsyncLocalStorage<NexusActivityStartContext> = (globalThis as any)[asyncLocalStorageSymbol];

/**
 * Runs `fn` with `context` set as the ambient {@link NexusActivityStartContext} for the duration of
 * the call (including through any async continuation reachable from it).
 *
 * @internal
 * @hidden
 */
export function runWithNexusActivityStartContext<T>(
  context: NexusActivityStartContext,
  fn: () => Promise<T>
): Promise<T> {
  return asyncLocalStorage.run(context, fn);
}

/**
 * Returns the ambient {@link NexusActivityStartContext} set by
 * {@link runWithNexusActivityStartContext}, or `undefined` if not currently inside a Nexus
 * `startOperation` handler invocation.
 *
 * @internal
 * @hidden
 */
export function getNexusActivityStartContext(): NexusActivityStartContext | undefined {
  return asyncLocalStorage.getStore();
}
