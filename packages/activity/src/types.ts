// Thrown in an activity
export class CancellationError extends Error {
  public readonly name: string = 'CancellationError';
}

export interface Context {
  cancelled: Promise<never>;
}
