import '@temporal-sdk/workflow';

async function sleep(ms: number) {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main() {
  await sleep(100);
  console.log('slept');
}
