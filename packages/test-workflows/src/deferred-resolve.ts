import '@temporalio/workflow';

export async function main(): Promise<void> {
  new Promise((resolve) => resolve(2)).then((val) => console.log(val));
  console.log(1);
}
