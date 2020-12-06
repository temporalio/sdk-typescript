async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main() {
  await sleep(100);
  console.log('slept');
}
