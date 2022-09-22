/**
 * Helper to prevent undefined and null values overriding defaults when merging maps
 */
export function filterNullAndUndefined<T extends Record<string, any>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([_k, v]) => v != null)) as any;
}
