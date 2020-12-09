async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main() {
  const p1 = new Promise((resolve) => resolve(undefined)).then(() => console.log(1));
  const p2 = sleep(100).then(() => console.log(2));
  await p1;
  await p2;
}
