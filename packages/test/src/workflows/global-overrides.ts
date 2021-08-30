/* eslint-disable @typescript-eslint/ban-ts-comment */
/**
 * Test that we get meaningful errors when trying to use Weak* constructors.
 * NOTE that we had to add @ts-ignore to all of the constructor calls because
 * workflows intentionally do not include Weak* types and typescript complains
 * and suggests changing the `lib` compiler option to es2015 or later when used.
 */
const startupErrors: string[] = [];

try {
  new WeakMap();
} catch (err: any) {
  startupErrors.push(err.toString());
}

export async function main(): Promise<void> {
  for (const err of startupErrors) {
    console.log(err);
  }
  try {
    new WeakMap();
  } catch (err: any) {
    console.log(err.toString());
  }
  try {
    new WeakSet();
  } catch (err: any) {
    console.log(err.toString());
  }
  try {
    // @ts-ignore
    new WeakRef();
  } catch (err: any) {
    console.log(err.toString());
  }
}
