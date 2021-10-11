class CustomError extends Error {
  public readonly name: string = 'CustomError';
}

export async function rejectPromise(): Promise<void> {
  try {
    await new Promise((_, reject) => reject(new CustomError('abc')));
  } catch (err) {
    console.log(err instanceof CustomError);
  }
  try {
    await Promise.reject(new CustomError('def'));
  } catch (err) {
    console.log(err instanceof CustomError);
  }
}
