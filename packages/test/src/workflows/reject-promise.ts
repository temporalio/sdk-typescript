import { Empty } from '../interfaces';

class CustomError extends Error {
  public readonly name: string = 'CustomError';
}

async function execute(): Promise<void> {
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

export const rejectPromise: Empty = () => ({ execute });
