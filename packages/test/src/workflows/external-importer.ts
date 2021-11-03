import fromPairs from 'ramda/src/fromPairs';

export async function externalImporter(): Promise<void> {
  const obj = fromPairs([
    ['a', 1],
    ['b', 2],
  ]);
  console.log(obj);
}
