import { temporal, coresdk } from '@temporalio/proto';
import { Client } from '@temporalio/client';
import { History } from './runtime';
import { WorkflowExecution } from '@temporalio/client';

export type EvictionReason = coresdk.workflow_activation.RemoveFromCache.EvictionReason;
export const EvictionReason = coresdk.workflow_activation.RemoveFromCache.EvictionReason;
export type RemoveFromCache = coresdk.workflow_activation.IRemoveFromCache;

/**
 * Error thrown when using the Worker to replay Workflow(s).
 */
export class ReplayError extends Error {
  public readonly name = 'ReplayError';

  constructor(
    /**
     * Workflow ID of the Workflow that failed to replay
     */
    public readonly workflowId: string,
    /**
     * Run ID of the Workflow that failed to replay
     */
    public runId: string,
    /**
     * Whether or not this error is caused by non-determinism
     */
    public readonly isNonDeterminism: boolean,
    /**
     * Why replay failed
     */
    message: string
  ) {
    super(message);
  }
}

export interface ReplayResults {
  readonly hasErrors: boolean;
  /** Maps run id to information about the replay failure */
  readonly errors: ReplayError[];
}

/**
 * @internal
 */
export interface ReplayRunOptions {
  failFast?: boolean;
}

/**
 * A workflow's history and ID. Useful for replay.
 */
export interface HistoryAndWorkflowId {
  workflowId: string;
  history: temporal.api.history.v1.History | unknown;
}

/**
 * An object containing an iterable of histories and their workflow IDs used for batch replaying.
 *
 * @experimental - this API is not considered stable
 */
export interface ReplayHistories {
  histories: AsyncIterable<HistoryAndWorkflowId> | Iterable<HistoryAndWorkflowId>;
}
/**
 * An object containing a client and an iterable of workflowIds and optional runIds to used for batch replaying.
 *
 * The client is used to download the histories concurrently.
 *
 * @experimental - this API is not considered stable
 */
export interface ReplayExecutions {
  /**
   * Client used to download histories.
   */
  client: Client;
  /**
   * (Async) Iterable of workflow executions to use as a source for history replays.
   */
  executions: AsyncIterable<WorkflowExecution> | Iterable<WorkflowExecution>;
  /**
   * Maximum number of histories that will be fetched concurrently.
   *
   * @default 5
   */
  maxConcurrency?: number;
}

/**
 * Histories or executions to replay.
 *
 * @experimental - this API is not considered stable
 */
export type ReplayHistoriesOrExecutions = ReplayExecutions | ReplayHistories;

/**
 * @internal
 */
export async function fetchWorkflowHistory(client: Client, workflowId: string, runId?: string): Promise<History> {
  let nextPageToken: Uint8Array | undefined = undefined;
  const history = Array<temporal.api.history.v1.IHistoryEvent>();
  for (;;) {
    const response: temporal.api.workflowservice.v1.GetWorkflowExecutionHistoryResponse =
      await client.connection.workflowService.getWorkflowExecutionHistory({
        nextPageToken,
        namespace: client.options.namespace,
        execution: { workflowId, runId },
      });
    history.push(...(response.history?.events ?? []));
    if (response.nextPageToken == null || response.nextPageToken.length === 0) break;
    nextPageToken = response.nextPageToken;
  }
  return temporal.api.history.v1.History.create({ events: history });
}

/**
 * Handles known possible cases of replay eviction reasons.
 *
 * Internally does not return undefined to get compilation errors when new reasons are added to the enum.
 *
 * @internal
 */
export function handleReplayEviction(evictJob: RemoveFromCache, workflowId: string, runId: string): ReplayError | null {
  switch (evictJob.reason) {
    case EvictionReason.NONDETERMINISM:
      return new ReplayError(
        workflowId,
        runId,
        true,
        'Replay failed with a nondeterminism error. This means that the workflow code as written ' +
          `is not compatible with the history that was fed in. Details: ${evictJob.message}`
      );
    case EvictionReason.LANG_FAIL:
      return new ReplayError(
        workflowId,
        runId,
        false,
        `Replay failed due workflow task failure. Details: ${evictJob.message}`
      );
    // Both of these reasons are not considered errors.
    // LANG_REQUESTED is used internally by Core to support duplicate runIds during replay.
    case EvictionReason.LANG_REQUESTED:
    case EvictionReason.CACHE_FULL:
      return null;
    case undefined:
    case null:
    case EvictionReason.UNSPECIFIED:
    case EvictionReason.CACHE_MISS:
    case EvictionReason.TASK_NOT_FOUND:
    case EvictionReason.UNHANDLED_COMMAND:
    case EvictionReason.FATAL:
      return new ReplayError(
        workflowId,
        runId,
        false,
        `Replay failed due to internal SDK issue. Code: ${
          evictJob.reason ? EvictionReason[evictJob.reason] : 'absent'
        }, Details: ${evictJob.message}`
      );
  }
}
