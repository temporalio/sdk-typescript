import '@temporal-sdk/workflow';

export async function main() {
  const res = await Promise.resolve(1).then((value) => new Promise((resolve) => resolve(value + 1)));
  console.log(res);
}
