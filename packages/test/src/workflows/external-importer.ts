import fromPairs from 'ramda/src/fromPairs';
import { Empty } from '../interfaces';

async function execute(): Promise<void> {
  const obj = fromPairs([
    ['a', 1],
    ['b', 2],
  ]);
  console.log(obj);
}

export const externalImporter: Empty = () => ({ execute });
