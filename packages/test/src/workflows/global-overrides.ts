/* eslint-disable @typescript-eslint/ban-ts-comment */

/**
 * Test that we get meaningful errors when trying to use the non-deterministic
 * WeakRef and FinalizationRegistry constructors.
 * NOTE: the @ts-ignore comments in the constructor calls are there because
 * WeakRef and FinalizationRegistry isn't defined in es2020 (lib in
 * @tsconfig/node14).
 */
const startupErrors: string[] = [];

try {
  // @ts-ignore
  new WeakRef();
} catch (err: any) {
  startupErrors.push(err.toString());
}

export async function globalOverrides(): Promise<void> {
  for (const err of startupErrors) {
    console.log(err);
  }
  try {
    // @ts-ignore
    new FinalizationRegistry();
  } catch (err: any) {
    console.log(err.toString());
  }
  try {
    // @ts-ignore
    new WeakRef();
  } catch (err: any) {
    console.log(err.toString());
  }

  const Temporal = (globalThis as any).Temporal;
  if (Temporal !== undefined) {
    const temporalNow = Temporal.Now;
    console.log(temporalNow.instant().epochMilliseconds);
    console.log(temporalNow.zonedDateTimeISO('UTC').epochMilliseconds);
    console.log(temporalNow.plainDateTimeISO('UTC').toString());
    console.log(temporalNow.plainDateISO('UTC').toString());
    console.log(temporalNow.plainTimeISO('UTC').toString());
    console.log(temporalNow.zonedDateTimeISO().timeZoneId);
    console.log(temporalNow.timeZoneId());
  }
}
