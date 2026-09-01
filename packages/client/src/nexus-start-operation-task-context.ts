import { AsyncLocalStorage } from 'node:async_hooks';
import type { temporal } from '@temporalio/proto';

/**
 * Ambient context set by `@temporalio/worker` for the duration of a Nexus `startOperation` task,
 * giving `ActivityClient` access to that task's request ID and inbound links for raw Activity
 * starts made during it.
 *
 * @internal
 * @hidden
 */
export interface NexusStartOperationTaskContext {
  /** The Nexus request's ID (never empty). */
  readonly requestId: string;

  /** Inbound links of the Nexus request currently being handled. */
  readonly links: temporal.api.common.v1.ILink[];

  /** Records a response link returned by an Activity start made during this invocation. */
  pushResponseLink(link: temporal.api.common.v1.ILink): void;
}

const asyncLocalStorageSymbol = Symbol.for('__temporal_nexus_activity_start_context_storage__');
if (!(globalThis as any)[asyncLocalStorageSymbol]) {
  (globalThis as any)[asyncLocalStorageSymbol] = new AsyncLocalStorage<NexusStartOperationTaskContext>();
}
const asyncLocalStorage: AsyncLocalStorage<NexusStartOperationTaskContext> = (globalThis as any)[
  asyncLocalStorageSymbol
];

/**
 * Runs `fn` with `context` set as the ambient {@link NexusStartOperationTaskContext} for the
 * duration of the call (including through any async continuation reachable from it).
 *
 * @internal
 * @hidden
 */
export function runWithNexusStartOperationTaskContext<T>(
  context: NexusStartOperationTaskContext,
  fn: () => Promise<T>
): Promise<T> {
  return asyncLocalStorage.run(context, fn);
}

/**
 * Returns the ambient {@link NexusStartOperationTaskContext} set by
 * {@link runWithNexusStartOperationTaskContext}, or `undefined` if not currently inside a Nexus
 * `startOperation` task.
 *
 * @internal
 * @hidden
 */
export function getNexusStartOperationTaskContext(): NexusStartOperationTaskContext | undefined {
  return asyncLocalStorage.getStore();
}
