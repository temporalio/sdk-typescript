export class WorkflowLocallyEvictedError extends Error {
  public override readonly name = 'WorkflowLocallyEvictedError';
}

export class WorkflowThreadLostError extends Error {
  public override readonly name = 'WorkflowThreadLostError';

  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
  }
}

/** Signals that Workflow cleanup failed and the owning Worker Thread must be discarded. */
export class WorkflowThreadDisposalError extends Error {
  public override readonly name = 'WorkflowThreadDisposalError';

  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
  }
}
