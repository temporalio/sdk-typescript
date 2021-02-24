import '@temporalio/workflow';

export async function main(): Promise<void> {
  const res = await (async () => 'async')();
  console.log(res);
}
