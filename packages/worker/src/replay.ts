import { temporal } from '@temporalio/proto';
import { Client } from '@temporalio/client';
import { History } from './runtime';
import { WorkflowExecution } from '@temporalio/client';

export interface ReplayResults {
  /** True if any workflow failed replay */
  readonly hadAnyFailure: boolean;
  /** Maps run id to information about the replay failure */
  readonly failureDetails: Map<string, Error>;
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
