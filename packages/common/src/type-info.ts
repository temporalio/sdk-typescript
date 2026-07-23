/**
 * Type information used to map an application value to an intermediate form appropriate for serialization.
 *
 * @experimental
 */
export interface TypeInfo<T = unknown> {
  mapper?: TypeMapper<T>;
}

/** @experimental */
export interface TypeMapper<T> {
  fromIntermediate(i: unknown): T;
  toIntermediate(o: T): unknown;
}
