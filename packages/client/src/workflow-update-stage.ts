import { temporal } from '@temporalio/proto';
import { makeProtoEnumConverters } from '@temporalio/common/lib/internal-workflow';

export const WorkflowUpdateStage = {
  /** Admitted stage. This stage is reached when the server accepts the update request. It is not
   * allowed to wait for this stage when using startUpdate, since the update request has not yet
   * been durably persisted at this stage. */
  ADMITTED: 'ADMITTED',

  /** Accepted stage. This stage is reached when a workflow has received the update and either
   * accepted it (i.e. it has passed validation, or there was no validator configured on the update
   * handler) or rejected it. This is currently the only allowed value when using startUpdate. */
  ACCEPTED: 'ACCEPTED',

  /** Completed stage. This stage is reached when a workflow has completed processing the
   * update with either a success or failure. */
  COMPLETED: 'COMPLETED',

  /**
   * This is not an allowed value.
   * @deprecated
   */
  UNSPECIFIED: undefined, // eslint-disable-line deprecation/deprecation
} as const;
export type WorkflowUpdateStage = (typeof WorkflowUpdateStage)[keyof typeof WorkflowUpdateStage];

export const [encodeWorkflowUpdateStage] = makeProtoEnumConverters<
  temporal.api.enums.v1.UpdateWorkflowExecutionLifecycleStage,
  typeof temporal.api.enums.v1.UpdateWorkflowExecutionLifecycleStage,
  keyof typeof temporal.api.enums.v1.UpdateWorkflowExecutionLifecycleStage,
  typeof WorkflowUpdateStage,
  'UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_'
>(
  {
    [WorkflowUpdateStage.ADMITTED]: 1,
    [WorkflowUpdateStage.ACCEPTED]: 2,
    [WorkflowUpdateStage.COMPLETED]: 3,
    UNSPECIFIED: 0,
  } as const,
  'UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_'
);
