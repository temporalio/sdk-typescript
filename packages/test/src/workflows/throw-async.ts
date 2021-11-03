export async function throwAsync(): Promise<void> {
  throw new Error('failure');
}
