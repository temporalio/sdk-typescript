interface BunGlobal {
  version: string;
  semver: {
    satisfies(version: string, range: string): boolean;
  };
}

const bun = (globalThis as typeof globalThis & { Bun?: BunGlobal }).Bun;

export const isBun = bun !== undefined;

// Bun versions before 1.4.0 need compatibility paths for VM microtask handling and Worker termination.
// https://github.com/oven-sh/bun/pull/32018
export const isBunPre1_4 = bun !== undefined && !bun.semver.satisfies(bun.version, '>=1.4.0');
