interface ErrorWithCode {
  code: string;
}

export function getErrorCode(error: unknown): string {
  if ((error as ErrorWithCode).code !== undefined && typeof (error as ErrorWithCode).code === 'string') {
    return (error as ErrorWithCode).code;
  } else {
    return '';
  }
}
