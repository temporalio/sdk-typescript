import { v4 as uuid4 } from 'uuid';
import {
  WorkflowOptions as BaseWorkflowOptions,
  WorkflowOptionsWithDefaults as BaseWorkflowOptionsWithDefaults,
} from '@temporalio/common/lib/workflow-options';
import * as iface from '@temporalio/proto';

export { CompiledWorkflowOptions, compileWorkflowOptions } from '@temporalio/common/lib/workflow-options';

export interface WorkflowOptions extends BaseWorkflowOptions {
  /**
   * Task queue to use for Workflow tasks. It should match a task queue specified when creating a
   * `Worker` that hosts the Workflow code.
   */
  taskQueue: string;

  followRuns?: boolean;
}

export interface WorkflowOptionsWithDefaults extends BaseWorkflowOptionsWithDefaults {
  /**
   * If set to true, instructs the client to follow the chain of execution before returning a Workflow's result.
   *
   * Workflow execution is chained if the Workflow has a cron schedule or continues-as-new or configured to retry
   * after failure or timeout.
   *
   * @default true
   */
  followRuns: boolean;
}

/**
 * Adds default values to `workflowId` and `workflowIdReusePolicy` to given workflow options.
 */
export function addDefaults(opts: WorkflowOptions): WorkflowOptionsWithDefaults {
  return {
    followRuns: true,
    workflowId: opts.workflowId ?? uuid4(),
    workflowIdReusePolicy:
      iface.temporal.api.enums.v1.WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE_FAILED_ONLY,
    ...opts,
  };
}
