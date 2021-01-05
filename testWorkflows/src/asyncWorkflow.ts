import '@temporal-sdk/workflow';

export async function main() {
  const res = await (async () => 'async')();
  console.log(res);
}
