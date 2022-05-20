import type { SearchAttributeValue } from '@temporalio/internal-workflow-common';
import { temporal } from '@temporalio/proto';

export interface WorkflowExecution {
  workflowId: string;
  runId?: string;
}
export type StartWorkflowExecutionRequest = temporal.api.workflowservice.v1.IStartWorkflowExecutionRequest;
export type GetWorkflowExecutionHistoryRequest = temporal.api.workflowservice.v1.IGetWorkflowExecutionHistoryRequest;
export type DescribeWorkflowExecutionResponse = temporal.api.workflowservice.v1.IDescribeWorkflowExecutionResponse;
export type TerminateWorkflowExecutionResponse = temporal.api.workflowservice.v1.ITerminateWorkflowExecutionResponse;
export type RequestCancelWorkflowExecutionResponse =
  temporal.api.workflowservice.v1.IRequestCancelWorkflowExecutionResponse;

export interface WorkflowExecutionDescription {
  type: string;
  workflowId: string;
  runId: string;
  taskQueue: string;
  status: temporal.api.enums.v1.WorkflowExecutionStatus;
  historyLength: Long;
  startTime: Date;
  executionTime?: Date;
  closeTime?: Date;
  memo?: Record<string, unknown>;
  searchAttributes?: Record<string, SearchAttributeValue>;
  parentExecution?: Required<temporal.api.common.v1.IWorkflowExecution>;
  raw: DescribeWorkflowExecutionResponse;
}
