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
 * - `performance` being undefined confirms polyfilling is needed (Date.now()
 *   is deterministic inside the sandbox, so this polyfill is safe).
 *
 * @module
 */

if ('__webpack_module_cache__' in globalThis && typeof performance === 'undefined') {
  Object.assign(globalThis, {
    performance: {
      timeOrigin: Date.now(),
      now() {
        return Date.now() - this.timeOrigin;
      },
    },
  });
}

// Empty export to mark this as a module for ESLint's import/unambiguous rule.
// This file intentionally has no imports to ensure it initializes before OTel.
export {};

