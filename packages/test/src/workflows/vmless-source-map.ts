export async function mappedFailure(): Promise<void> {
  throw new Error('source-map failure');
}
