import type { BundleOptions } from '@temporalio/worker';

/**
 * Base bundler options that can be extended by packages.
 * These are modules that should be ignored when bundling workflow code.
 */
export const baseBundlerIgnoreModules = [
  '@temporalio/common/lib/internal-non-workflow',
  '@temporalio/activity',
  '@temporalio/client',
  '@temporalio/testing',
  '@temporalio/nexus',
  '@temporalio/worker',
  'ava',
  'crypto',
  'module',
  'path',
  'stack-utils',
  '@grpc/grpc-js',
  'async-retry',
  'uuid',
  'net',
  'fs/promises',
  'timers',
  'timers/promises',
];

/**
 * Create base bundler options that can be extended with package-specific modules.
 *
 * @param additionalIgnoreModules - Additional modules to ignore when bundling
 * @returns BundlerOptions with ignoreModules
 */
export function createBaseBundlerOptions(additionalIgnoreModules: string[] = []): Partial<BundleOptions> {
  return {
    ignoreModules: [...baseBundlerIgnoreModules, ...additionalIgnoreModules],
  };
}
