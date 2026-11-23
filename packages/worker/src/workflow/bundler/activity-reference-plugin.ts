import type { Options } from '@swc/core';

/** @internal Load the Wasm artifact shipped alongside this Worker's pinned SWC host. */
export function withActivityReferences(options: Options): Options {
  return {
    ...options,
    jsc: {
      ...options.jsc,
      experimental: {
        ...options.jsc?.experimental,
        // SWC otherwise drops attributes before invoking Wasm plugins.
        keepImportAssertions: true,
        plugins: [
          // Native SWC reads this file directly; it is not a Workflow webpack module.
          [require.resolve('./activity-reference-plugin.wasm'), {}],
          ...(options.jsc?.experimental?.plugins ?? []),
        ],
      },
    },
  };
}
