export async function main() {
  const res = await (new Promise<number>((resolve) => resolve(1)).then((value) => new Promise((resolve) => resolve(value + 1))));
  console.log(res);
}
