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

function isObject(item: any): item is Record<string, any> {
  return item && typeof item === 'object' && !Array.isArray(item);
}

/**
 * Recursively merges two objects, returning a new object.
 *
 * Properties from `source` will overwrite properties on `target`.
 * Nested objects are merged recursively.
 *
 * Object fields in the returned object are references, as in,
 * the returned object is not completely fresh.
 */
export function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const output = { ...target };

  if (isObject(target) && isObject(source)) {
    for (const key of Object.keys(source)) {
      const sourceValue = source[key];
      if (isObject(sourceValue) && key in target && isObject(target[key] as any)) {
        output[key as keyof T] = deepMerge(target[key], sourceValue);
      } else {
        (output as any)[key] = sourceValue;
      }
    }
  }

  return output;
}
