import { Empty } from '../interfaces';

async function execute(): Promise<void> {
  const res = await Promise.resolve(1).then((value) => new Promise((resolve) => resolve(value + 1)));
  console.log(res);
}

export const promiseThenPromise: Empty = () => ({ execute });
