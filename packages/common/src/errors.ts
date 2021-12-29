export class ValueError extends Error {
  public readonly name: string = 'ValueError';
}

export class DataConverterError extends Error {
  public readonly name: string = 'DataConverterError';
}

/**
 * Used in different parts of the project to signal that something unexpected has happened
 */
export class IllegalStateError extends Error {
  public readonly name: string = 'IllegalStateError';
}

/**
 * Get error message from an Error or string or return undefined
 */
export function errorMessage(err: unknown): string | undefined {
  if (typeof err === 'string') {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return undefined;
}
