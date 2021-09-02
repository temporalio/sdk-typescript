import { Empty } from '../interfaces';

async function execute(): Promise<void> {
  new Promise((resolve) => resolve(2)).then((val) => console.log(val));
  console.log(1);
}

export const deferredResolve: Empty = () => ({ execute });
