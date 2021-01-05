import '@temporal-sdk/workflow';

export async function main() {
  // None promises
  console.log(...(await Promise.all([1, 2, 3])));
  // Normal promises
  console.log(...(await Promise.all([1, 2, 3].map((v) => Promise.resolve(v)))));
  // From iterable
  console.log(...(await Promise.all(new Map([['a', 1], ['b', 2], ['c', 3]]).values())));
  try {
    // Rejection
    await Promise.all([
      Promise.reject(new Error('wow')),
      1,
      2,
    ]);
  } catch (err) {
    console.log(err.message);
  }
}
