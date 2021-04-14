/**
 * This library provides tools required for writing workflows.
 *
 * ### Usage
 *
 * `src/interfaces/workflows.ts`
 *
 * ```ts
 * import { Workflow } from '@temporalio/workflow';
 *
 * // Extend the generic Workflow interface to check that Echo is a valid workflow interface
 * export interface Echo extends Workflow {
 *   main(name: string): Promise<string>;
 * }
 * ```
 *
 * `src/workflows/echo.ts`
 *
 * ```ts
 * import { sleep } from '@temporalio/workflow';
 * import { Example } from '@interfaces/workflows';
 *
 * async function main(input: string): Promise<string> {
 *   await sleep(500); // Wait 500 milliseconds before doing anything for this example
 *   return input;
 * }
 *
 * export const workflow: Echo = { main };
 * ```
 *
 * ### Importing in workflow code
 *
 * Workflow code can reliably import [ES modules](https://nodejs.org/api/esm.html#esm_modules_ecmascript_modules).
 * In order for the Typescript compiler to output ES modules we set the [`module` compiler option] to `es2020` in the initializer project (`npm init @temporalio`).
 * [CommonJS](https://nodejs.org/docs/latest/api/modules.html#modules_modules_commonjs_modules) modules are experimentally supported via babel transformation using [babel-plugin-transform-commonjs](https://www.npmjs.com/package/babel-plugin-transform-commonjs).
 * Built-in node modules are not supported and will throw an exception on import.
 *
 * ### Determinism
 *
 * See: https://github.com/temporalio/sdk-node/blob/more-documentation/docs/determinism.md
 *
 * ### Cancellation
 *
 * See: https://github.com/temporalio/sdk-node/blob/more-documentation/docs/workflow-scopes-and-cancellation.md
 * @module
 */

import './global-overrides';

export {
  Workflow,
  ActivityOptions,
  RemoteActivityOptions,
  LocalActivityOptions,
  ActivityFunction,
  RetryOptions,
} from './interfaces';
export { CancellationError, CancellationSource } from './errors';
export {
  Context,
  ContextImpl,
  sleep,
  cancel,
  cancellationScope,
  shield,
  uuid4,
  validateActivityOptions,
  scheduleActivity,
} from './workflow';
