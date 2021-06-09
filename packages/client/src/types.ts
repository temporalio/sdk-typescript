import { temporal } from '@temporalio/proto';

export type StartWorkflowExecutionRequest = temporal.api.workflowservice.v1.IStartWorkflowExecutionRequest;
export type GetWorkflowExecutionHistoryRequest = temporal.api.workflowservice.v1.IGetWorkflowExecutionHistoryRequest;
export type DescribeWorkflowExecutionResponse = temporal.api.workflowservice.v1.IDescribeWorkflowExecutionResponse;
export type TerminateWorkflowExecutionResponse = temporal.api.workflowservice.v1.ITerminateWorkflowExecutionResponse;
export type RequestCancelWorkflowExecutionResponse =
  temporal.api.workflowservice.v1.IRequestCancelWorkflowExecutionResponse;
