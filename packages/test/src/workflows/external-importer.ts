import '@temporalio/workflow';
import fromPairs from 'ramda/es/fromPairs';

export async function execute(): Promise<void> {
  const obj = fromPairs([
    ['a', 1],
    ['b', 2],
  ]);
  console.log(obj);
}
