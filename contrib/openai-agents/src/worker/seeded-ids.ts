import { AsyncLocalStorage } from 'node:async_hooks';

export interface SeededIdStore {
  trace?: string;
  span?: string;
}

export const seedsStorage = new AsyncLocalStorage<SeededIdStore>();

/** Scopes `traceSeed`/`spanSeed` for one `tracer.startSpan(...)` call. */
export function withSeededIds<T>(traceSeed: string | undefined, spanSeed: string | undefined, fn: () => T): T {
  return seedsStorage.run({ trace: traceSeed, span: spanSeed }, fn);
}
