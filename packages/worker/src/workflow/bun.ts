interface BunGlobal {
  version: string;
  semver: {
    satisfies(version: string, range: string): boolean;
  };
}

const bun = (globalThis as typeof globalThis & { Bun?: BunGlobal }).Bun;

export const isBun = bun !== undefined;

export function assertSupportedBunVersion(): void {
  if (bun !== undefined && !bun.semver.satisfies(bun.version, '>=1.4.0')) {
    throw new Error('Bun versions older than 1.4.0 are not supported. Please upgrade to Bun 1.4.0 or later.');
  }
}
