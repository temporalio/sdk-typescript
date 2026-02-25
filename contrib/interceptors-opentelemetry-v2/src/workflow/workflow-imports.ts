/**
 * Workflow imports stub module.
 *
 * This module provides stubs for workflow functionality needed by interceptors.
 * When bundled by the workflow bundler, this is replaced with the real
 * implementation via NormalModuleReplacementPlugin.
 *
 * @module
 */
import type {
  inWorkflowContext as inWorkflowContextT,
  workflowInfo as workflowInfoT,
  proxySinks as proxySinksT,
  AsyncLocalStorage as AsyncLocalStorageT,
  ContinueAsNew as ContinueAsNewT,
} from '@temporalio/workflow';
import type { getActivator as getActivatorT } from '@temporalio/workflow/lib/global-attributes';
import type { SdkFlags as SdkFlagsT } from '@temporalio/workflow/lib/flags';
import type { alea as aleaT, RNG } from '@temporalio/workflow/lib/alea';

import { IllegalStateError } from '@temporalio/common';

// always returns false since if using this implementation, we are outside of workflow context
export const inWorkflowContext: typeof inWorkflowContextT = () => false;

// All of the following stubs will throw if used
export const workflowInfo: typeof workflowInfoT = () => {
  throw new IllegalStateError('Workflow.workflowInfo(...) may only be used from a Workflow Execution.');
};

export const ContinueAsNew = class ContinueAsNew {} as unknown as typeof ContinueAsNewT;

export const AsyncLocalStorage = class AsyncLocalStorage {} as unknown as typeof AsyncLocalStorageT;

export const getActivator: typeof getActivatorT = () => {
  throw new IllegalStateError('Workflow uninitialized');
};

export const proxySinks: typeof proxySinksT = () => {
  throw new IllegalStateError('Proxied sinks functions may only be used from a Workflow Execution.');
};

export const SdkFlags: typeof SdkFlagsT = {} as typeof SdkFlagsT;

export type { RNG };

export const alea: typeof aleaT = () => {
  throw new IllegalStateError('alea may only be used from a Workflow Execution.');
};
