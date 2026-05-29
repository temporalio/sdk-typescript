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

export function randomHex(len: number): string {
  const bytes = new Uint8Array(len / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
