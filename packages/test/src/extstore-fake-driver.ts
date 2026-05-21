/**
 * Shared test double for {@link StorageDriver}. By default it stores and retrieves
 * payloads via an in-memory `Map`, so a runExternalStore→runExternalRetrieve round-trip
 * yields the original bytes. Tests that need failure or unusual-shape responses can
 * override individual operations via `onStore` / `onRetrieve`.
 *
 * Every call is recorded on `storeCalls` / `retrieveCalls` (the recording happens
 * before the override runs, so an override can introspect its own call).
 */
import {
  type Payload,
  type StorageDriver,
  StorageDriverClaim,
  type StorageDriverRetrieveContext,
  type StorageDriverStoreContext,
} from '@temporalio/common';

export interface FakeDriver extends StorageDriver {
  storeCalls: { context: StorageDriverStoreContext; payloads: Payload[] }[];
  retrieveCalls: { context: StorageDriverRetrieveContext; claims: StorageDriverClaim[] }[];
}

export interface FakeDriverOptions {
  /** Driver name. Defaults to `'mem'`. */
  name?: string;
  /** Override default in-memory store. */
  onStore?: (payloads: Payload[]) => StorageDriverClaim[] | Promise<StorageDriverClaim[]>;
  /** Override default in-memory retrieve. */
  onRetrieve?: (claims: StorageDriverClaim[]) => Payload[] | Promise<Payload[]>;
}

export function makeFakeDriver(opts: FakeDriverOptions = {}): FakeDriver {
  const name = opts.name ?? 'mem';
  const memory = new Map<string, Payload>();
  let nextId = 0;
  const driver: FakeDriver = {
    name,
    type: name,
    storeCalls: [],
    retrieveCalls: [],
    async store(context, payloads) {
      driver.storeCalls.push({ context, payloads });
      if (opts.onStore) return opts.onStore(payloads);
      return payloads.map((p) => {
        const id = `${name}-${nextId++}`;
        memory.set(id, p);
        return new StorageDriverClaim({ id });
      });
    },
    async retrieve(context, claims) {
      driver.retrieveCalls.push({ context, claims });
      if (opts.onRetrieve) return opts.onRetrieve(claims);
      return claims.map((c) => memory.get(c.claimData.id!)!);
    },
  };
  return driver;
}
