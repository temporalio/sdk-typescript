import '@temporal-sdk/workflow';
import * as R from 'ramda';

export async function main() {
  const obj = R.fromPairs([['a', 1], ['b', 2]]);
  console.log(obj);
}
