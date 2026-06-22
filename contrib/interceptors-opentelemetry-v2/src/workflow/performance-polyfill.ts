/**
 * Polyfill performance for the workflow isolate.
 *
 * OTel v2's browser platform accesses `performance` at module scope.
 * This file MUST have zero imports so webpack initializes it before any
 * OTel module that references `performance`.
 *
 * The guard uses two checks:
 * - `__webpack_module_cache__` on globalThis is a positive indicator of the
 *   workflow sandbox (set by the SDK's VM creators before the bundle evaluates).
 * - `performance` being undefined confirms polyfilling is needed. The polyfill
 *   reads workflow time from the activator so it is safe during preload.
 *
 * @module
 */

if ('__webpack_module_cache__' in globalThis && typeof performance === 'undefined') {
  const now = () => ((globalThis as any).__TEMPORAL_ACTIVATOR__?.now as number | undefined) ?? 0;
  Object.assign(globalThis, {
    performance: {
      timeOrigin: now(),
      now() {
        return now() - this.timeOrigin;
      },
    },
  });
}

// Empty export to mark this as a module for ESLint's import/unambiguous rule.
// This file intentionally has no imports to ensure it initializes before OTel.
export {};
