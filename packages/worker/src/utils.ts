export const MiB = 1024 ** 2;
export const GiB = MiB * 1024;

export function partition<T>(arr: T[], predicate: (x: T) => boolean): [T[], T[]] {
  const truthy = Array<T>();
  const falsy = Array<T>();
  arr.forEach((v) => (predicate(v) ? truthy : falsy).push(v));
  return [truthy, falsy];
}

export function toMB(bytes: number, fractionDigits = 2): string {
  return (bytes / 1024 / 1024).toFixed(fractionDigits);
}

/**
 * Helper to prevent undefined and null values overriding defaults when merging maps
 */
export function filterNullAndUndefined<T extends Record<string, any>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([_k, v]) => v != null)) as any;
}
