import '@temporalio/workflow';
import * as R from 'ramda';

export async function main(): Promise<void> {
  const obj = R.fromPairs([
    ['a', 1],
    ['b', 2],
  ]);
  console.log(obj);
}
