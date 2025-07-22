/**
 * Helper to prevent `undefined` and `null` values overriding defaults when merging maps.
 */
export function filterNullAndUndefined<T extends Record<string, any>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([_k, v]) => v != null)) as any;
}

/**
 * Merge two objects, possibly removing keys.
 *
 * More specifically:
 * - Any key/value pair in `delta` overrides the corresponding key/value pair in `original`;
 * - A key present in `delta` with value `undefined` removes the key from the resulting object;
 * - If `original` is `undefined` or empty, return `delta`;
 * - If `delta` is `undefined` or empty, return `original` (or undefined if `original` is also undefined);
 * - If there are no changes, then return `original`.
 */
export function mergeObjects<T extends Record<string, any>>(original: T, delta: T | undefined): T;
export function mergeObjects<T extends Record<string, any>>(
  original: T | undefined,
  delta: T | undefined
): T | undefined {
  if (original == null) return delta;
  if (delta == null) return original;

  const merged: Record<string, any> = { ...original };
  let changed = false;
  for (const [k, v] of Object.entries(delta)) {
    if (v !== merged[k]) {
      if (v == null) delete merged[k];
      else merged[k] = v;
      changed = true;
    }
  }

  return changed ? (merged as T) : original;
}
