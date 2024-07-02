import { temporal } from '@temporalio/proto';
import { checkExtends } from '@temporalio/common/lib/type-helpers';

export enum WorkflowUpdateStage {
  /** This is not an allowed value. */
  UNSPECIFIED = 0,
  /** Admitted stage. This stage is reached when the server accepts the update request. It is not
   * allowed to wait for this stage when using startUpdate, since the update request has not yet
   * been durably persisted at this stage. */
  ADMITTED = 1,
  /** Accepted stage. This stage is reached when a workflow has received the update and either
   * accepted it (i.e. it has passed validation, or there was no validator configured on the update
   * handler) or rejected it. This is currently the only allowed value when using startUpdate. */
  ACCEPTED = 2,
  /** Completed stage. This stage is reached when a workflow has completed processing the
   * update with either a success or failure. */
  COMPLETED = 3,
}

checkExtends<
  `UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_${keyof typeof WorkflowUpdateStage}`,
  keyof typeof temporal.api.enums.v1.UpdateWorkflowExecutionLifecycleStage
>();
checkExtends<
  keyof typeof temporal.api.enums.v1.UpdateWorkflowExecutionLifecycleStage,
  `UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_${keyof typeof WorkflowUpdateStage}`
>();

export function toProtoEnum(stage: WorkflowUpdateStage): temporal.api.enums.v1.UpdateWorkflowExecutionLifecycleStage {
  return temporal.api.enums.v1.UpdateWorkflowExecutionLifecycleStage[
    `UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_${WorkflowUpdateStage[stage] as keyof typeof WorkflowUpdateStage}`
  ];
}
