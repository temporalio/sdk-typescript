export async function asyncWorkflow(): Promise<string> {
  return await (async () => 'async')();
}
