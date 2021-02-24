import '@temporalio/workflow';

export async function main(): Promise<void> {
  console.log(new Date().getTime());
  console.log(Date.now());
  console.log(new Date() instanceof Date);
}
