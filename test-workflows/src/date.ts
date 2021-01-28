import '@temporal-sdk/workflow';

export async function main() {
  console.log(new Date().getTime());
  console.log(Date.now());
  console.log(new Date() instanceof Date);
}
