export async function throwObject(): Promise<void> {
  throw { plainObject: true };
}
