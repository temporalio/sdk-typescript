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
