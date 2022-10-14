export interface ReplayResults {
  // True if any workflow failed replay
  readonly hadAnyFailure: boolean;
  // Maps run id to information about the replay failure
  readonly failureDetails: Map<string, Error>;
}

export interface ReplayRunOptions {
  failFast?: boolean;
}
