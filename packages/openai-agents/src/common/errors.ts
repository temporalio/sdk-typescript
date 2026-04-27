/**
 * Error type used by TemporalOpenAIRunner to wrap non-Temporal errors thrown
 * during agent execution. The runner passes an instance of this as the `cause`
 * of an ApplicationFailure so the class name is preserved through serialization
 * (e.g., err.cause.cause.name === 'AgentsWorkflowError' on the client side,
 * or err.cause.name === 'AgentsWorkflowError' inside the workflow).
 */
export class AgentsWorkflowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentsWorkflowError';
  }
}
