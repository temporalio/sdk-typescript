import { WorkerDeploymentVersion } from '@temporalio/common';
import type { coresdk, temporal } from '@temporalio/proto';
import { IllegalStateError, ParentWorkflowInfo, RootWorkflowInfo } from '@temporalio/workflow';

export const MiB = 1024 ** 2;

export function toMB(bytes: number, fractionDigits = 2): string {
  return (bytes / 1024 / 1024).toFixed(fractionDigits);
}

export function byteArrayToBuffer(array: Uint8Array): Buffer {
  return Buffer.from(array, array.byteOffset, array.byteLength + array.byteOffset);
}

export function convertToParentWorkflowType(
  parent: coresdk.common.INamespacedWorkflowExecution | null | undefined
): ParentWorkflowInfo | undefined {
  if (!parent) {
    return undefined;
  }

  if (!parent.workflowId || !parent.runId || !parent.namespace) {
    throw new IllegalStateError('Parent INamespacedWorkflowExecution is missing a field that should be defined');
  }

  return {
    workflowId: parent.workflowId,
    runId: parent.runId,
    namespace: parent.namespace,
  };
}

export function convertDeploymentVersion(
  v: coresdk.common.IWorkerDeploymentVersion | null | undefined
): WorkerDeploymentVersion | undefined {
  if (v == null || v.buildId == null) {
    return undefined;
  }

  return {
    buildId: v.buildId,
    deploymentName: v.deploymentName ?? '',
  };
}

export function convertToRootWorkflowType(
  root: temporal.api.common.v1.IWorkflowExecution | null | undefined
): RootWorkflowInfo | undefined {
  if (root == null) {
    return undefined;
  }
  if (!root.workflowId || !root.runId) {
    throw new IllegalStateError('Root workflow execution is missing a field that should be defined');
  }

  return {
    workflowId: root.workflowId,
    runId: root.runId,
  };
}
