/**
 * Web/Node global polyfills for the Temporal Workflow sandbox.
 *
 * `@google/adk` and `@google/genai` reference `Headers`, `structuredClone`,
 * and the WHATWG streams globals while building requests in the agent loop,
 * and ADK's telemetry modules reach `@opentelemetry/core`'s browser build,
 * which dereferences the `performance` global at module load. The Workflow
 * sandbox does not expose all of them, so we install minimal polyfills — but
 * ONLY inside Workflow context (gated on `inWorkflowContext()`), so a normal
 * Node import (the worker / Activity side, tests, direct ADK use) is left
 * untouched. The `./workflow` entry point imports this module for its side
 * effect, and `GoogleAdkPlugin.configureBundler` additionally prepends it to
 * `workflowInterceptorModules`, which guarantees per-workflow evaluation
 * before the user's workflow module regardless of user import order.
 */

import { inWorkflowContext, type WorkflowInterceptorsFactory } from '@temporalio/workflow';

// Satisfies the documented interceptor-module contract (modules on
// `workflowInterceptorModules` export an `interceptors` factory); this module
// is on that list purely for its load-time side effect, so it registers none.
export const interceptors: WorkflowInterceptorsFactory = () => ({});

if (inWorkflowContext()) {
  const globals = globalThis as Record<string, unknown>;

  if (typeof globals.Headers === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Headers } = require('headers-polyfill');
    globals.Headers = Headers;
  }

  if (typeof globals.structuredClone === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    globals.structuredClone = require('@ungap/structured-clone').default;
  }

  if (typeof globals.ReadableStream === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports,import/no-unassigned-import
    require('web-streams-polyfill/polyfill');
  }

  if (typeof globals.performance === 'undefined') {
    // `@opentelemetry/core`'s browser build (reached from ADK's telemetry
    // modules through `@opentelemetry/sdk-trace-base`) evaluates
    // `export const otperformance = performance` at module load, and span
    // timestamps flow through `performance.timeOrigin` / `performance.now()`.
    // Both map onto the sandbox-patched `Date.now()` (workflow time), so the
    // values are deterministic under replay. Mirrors the shim
    // `@temporalio/interceptors-opentelemetry` installs from its own workflow
    // runtime module; ours yields to an existing shim, while that package's
    // unconditional `Object.assign` may later replace ours — harmless either
    // way, since both compute identical values from the same sandbox clock.
    const timeOrigin = Date.now();
    globals.performance = {
      timeOrigin,
      now() {
        return Date.now() - timeOrigin;
      },
    };
  }
}
