/**
 * Workflow imports stub module.
 *
 * This module provides stubs for workflow functionality needed by interceptors.
 * When bundled by the workflow bundler, this is replaced with the real
 * implementation via module-overrides.
 *
 * @module
 */
import type {
  WorkflowInfo,
  Sinks,
  AsyncLocalStorage as AsyncLocalStorageT,
  ContinueAsNew as ContinueAsNewT,
} from '@temporalio/workflow';
import type { Activator } from '@temporalio/workflow/lib/internals';
import type { SdkFlags as SdkFlagsT } from '@temporalio/workflow/lib/flags';

import { IllegalStateError } from '@temporalio/common';

/** Stub: always returns false outside workflow context */
export function inWorkflowContext(): boolean {
  return false;
}

/** Stub: throws outside workflow context */
export function workflowInfo(): WorkflowInfo {
  throw new IllegalStateError('Workflow.workflowInfo(...) may only be used from a Workflow Execution.');
}

/** Stub: ContinueAsNew error class */
export const ContinueAsNew = {} as typeof ContinueAsNewT;

/** Stub: no-op AsyncLocalStorage */
export const AsyncLocalStorage = {} as typeof AsyncLocalStorageT;

export function getActivator(): Activator {
  throw new IllegalStateError('Workflow uninitialized');
}

/** Stub: throws outside workflow context */
export function proxySinks<T extends Sinks>(): T {
  throw new IllegalStateError('Proxied sinks functions may only be used from a Workflow Execution.');
}

export const SdkFlags = {} as typeof SdkFlagsT;
