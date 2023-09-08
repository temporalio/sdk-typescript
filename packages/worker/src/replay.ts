import { HistoryAndWorkflowId } from '@temporalio/client';
import { SymbolBasedInstanceOfError } from '@temporalio/common/lib/type-helpers';
import { coresdk } from '@temporalio/proto';
import { DeterminismViolationError } from '@temporalio/workflow';

export type EvictionReason = coresdk.workflow_activation.RemoveFromCache.EvictionReason;
export const EvictionReason = coresdk.workflow_activation.RemoveFromCache.EvictionReason;
export type RemoveFromCache = coresdk.workflow_activation.IRemoveFromCache;

/**
 * Error thrown when using the Worker to replay Workflow(s).
 */
@SymbolBasedInstanceOfError('ReplayError')
export class ReplayError extends Error {}

/**
 * Result of a single workflow replay
 */
export interface ReplayResult {
  readonly workflowId: string;
  readonly runId: string;
  readonly error?: ReplayError | DeterminismViolationError;
}

/**
 * An iterable on workflow histories and their IDs, used for batch replaying.
 */
export type ReplayHistoriesIterable = AsyncIterable<HistoryAndWorkflowId> | Iterable<HistoryAndWorkflowId>;

/**
 * Handles known possible cases of replay eviction reasons.
 *
 * Internally does not return undefined to get compilation errors when new reasons are added to the enum.
 *
 * @internal
 */
export function evictionReasonToReplayError(
  evictJob: RemoveFromCache
): ReplayError | DeterminismViolationError | undefined {
  switch (evictJob.reason) {
    case EvictionReason.NONDETERMINISM:
      return new DeterminismViolationError(
        'Replay failed with a nondeterminism error. This means that the workflow code as written ' +
          `is not compatible with the history that was fed in. Details: ${evictJob.message}`
      );
    case EvictionReason.LANG_FAIL:
      return new ReplayError(`Replay failed due workflow task failure. Details: ${evictJob.message}`);
    // Both of these reasons are not considered errors.
    // LANG_REQUESTED is used internally by Core to support duplicate runIds during replay.
    case EvictionReason.LANG_REQUESTED:
    case EvictionReason.CACHE_FULL:
      return undefined;
    case undefined:
    case null:
    case EvictionReason.UNSPECIFIED:
    case EvictionReason.CACHE_MISS:
    case EvictionReason.TASK_NOT_FOUND:
    case EvictionReason.UNHANDLED_COMMAND:
    case EvictionReason.PAGINATION_OR_HISTORY_FETCH:
    case EvictionReason.FATAL:
      return new ReplayError(
        `Replay failed due to internal SDK issue. Code: ${
          evictJob.reason ? EvictionReason[evictJob.reason] : 'absent'
        }, Details: ${evictJob.message}`
      );
  }
}
