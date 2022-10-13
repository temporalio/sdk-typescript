import { temporal } from '@temporalio/proto';
import History = temporal.api.history.v1.History;

export interface ReplayResults {
  // True if any workflow failed replay
  readonly hadAnyFailure: boolean;
  // Maps run id to information about the replay failure
  readonly failureDetails: Map<string, Error>;
}

export interface HistoryAndWorkflowID {
  workflowID: string;
  history: History | unknown;
}

export interface ReplayRunOptions {
  failFast?: boolean;
}
