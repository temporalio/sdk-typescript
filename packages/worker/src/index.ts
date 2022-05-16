/**
 * The temporal worker connects to the service and runs workflows and activities.
 *
 * ### Usage
 *
 * <!--SNIPSTART typescript-hello-worker-->
 * <!--SNIPEND-->
 * @module
 */

import { IllegalStateError } from '@temporalio/internal-workflow-common';

if ((globalThis as any).__TEMPORAL__ !== undefined) {
  throw new IllegalStateError(
    "You are importing from '@temporalio/worker' in your Workflow code, which doesn't work. Workflow code should only import from '@temporalio/workflow' and '@temporalio/common'."
  );
}

export { NativeConnection as NativeConnection } from './connection';
export { NativeConnectionOptions, RequiredNativeConnectionOptions, TLSConfig } from './connection-options';
export * from './errors';
export * from './interceptors';
export * from './logger';
export { History, Runtime, RuntimeOptions, TelemetryOptions } from './runtime';
export * from './sinks';
export { DataConverter, defaultPayloadConverter, errors, State, Worker } from './worker';
export { CompiledWorkerOptions, WorkerOptions } from './worker-options';
export { BundleOptions, bundleWorkflowCode } from './workflow/bundler';
