/**
 * A custom payload-converter module that imports `@google/adk`, following the
 * documented workaround: converter modules evaluate before interceptor modules
 * (so before the plugin's polyfill loader), and must therefore import
 * `@temporalio/google-adk-agents/workflow` first to install the sandbox
 * polyfills themselves. The E2E test bundles the tsc-compiled CommonJS form of
 * this file (`lib/__tests__/adk-converter.js`), where every `require` is eager
 * — the module layout that crashed on the `performance` global before the
 * polyfill loader shimmed it.
 */

// The documented workaround import — must come first.
// eslint-disable-next-line import/no-unassigned-import
import '../workflow';
import { LlmAgent } from '@google/adk';
import { defaultPayloadConverter } from '@temporalio/common';

/** Referenced so the `@google/adk` barrel import is not elided. */
export const adkEvaluated = typeof LlmAgent === 'function';

export const payloadConverter = defaultPayloadConverter;
