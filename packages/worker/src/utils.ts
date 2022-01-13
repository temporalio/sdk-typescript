export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export const identity = <T>(x: T): T => x;

export const GiB = 1024 ** 3;
export const MiB = 1024 ** 2;

export function partition<T>(arr: T[], predicate: (x: T) => boolean): [T[], T[]] {
  const truthy = Array<T>();
  const falsy = Array<T>();
  arr.forEach((v) => (predicate(v) ? truthy : falsy).push(v));
  return [truthy, falsy];
}

export function toMB(bytes: number, fractionDigits = 2): string {
  return (bytes / 1024 / 1024).toFixed(fractionDigits);
}
