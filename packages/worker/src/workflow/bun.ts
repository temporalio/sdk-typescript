interface BunGlobal {
  version: string;
  semver: {
    satisfies(version: string, range: string): boolean;
  };
}

const bun = (globalThis as typeof globalThis & { Bun?: BunGlobal }).Bun;

export const isBun = bun !== undefined;

// Bun supports vm.createContext({ microtaskMode: 'afterEvaluate' }) as of 1.4.0.
// https://github.com/oven-sh/bun/pull/32018
export const needsBunMicrotaskModeWorkaround = bun !== undefined && !bun.semver.satisfies(bun.version, '>=1.4.0');
