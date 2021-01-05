import '@temporal-sdk/workflow';

export async function main() {
  new Promise((resolve) => resolve(2)).then((val) => console.log(val));
  console.log(1);
}
