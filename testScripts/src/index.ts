async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main() {
  await sleep(1000);
  console.log('slept');
}
