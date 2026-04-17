import type { WorkerDeploymentVersion } from '@temporalio/common';
import type { coresdk, temporal } from '@temporalio/proto';
import type { ParentWorkflowInfo, RootWorkflowInfo } from '@temporalio/workflow';

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
  if (!parent || !parent.workflowId || !parent.runId || !parent.namespace) {
    return undefined;
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
  if (!v || !v.buildId) {
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
  if (!root || !root.workflowId || !root.runId) {
    return undefined;
  }

  return {
    workflowId: root.workflowId,
    runId: root.runId,
  };
}
