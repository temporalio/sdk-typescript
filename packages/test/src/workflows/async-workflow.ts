import '@temporalio/workflow';

export async function execute(): Promise<void> {
  const res = await (async () => 'async')();
  console.log(res);
}
