/**
 * Type information used to map an application value to an intermediate value and optionally
 * provide converter-specific serialization information.
 *
 * @experimental
 */
export interface TypeInfo<T = unknown, D = T> {
  mapper?: TypeMapper<T>;
  hint?: ConverterHint<D>;
}

/** @experimental */
export interface TypeMapper<T> {
  fromIntermediate(i: unknown): T;
  toIntermediate(o: T): unknown;
}

export declare const valueTypeBrand: unique symbol;

/** @experimental */
export interface ConverterHint<T = unknown> {
  converter: string;
  [valueTypeBrand]?: T;
}
