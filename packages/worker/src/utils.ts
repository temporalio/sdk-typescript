import type { coresdk } from '@temporalio/proto';
import { IllegalStateError, ParentWorkflowInfo } from '@temporalio/workflow';

export const MiB = 1024 ** 2;
export const GiB = MiB * 1024;

// ts-prune-ignore-next (no idea why ts-prune is complaining all of a sudden)
export function partition<T>(arr: T[], predicate: (x: T) => boolean): [T[], T[]] {
  const truthy = Array<T>();
  const falsy = Array<T>();
  arr.forEach((v) => (predicate(v) ? truthy : falsy).push(v));
  return [truthy, falsy];
}

export function toMB(bytes: number, fractionDigits = 2): string {
  return (bytes / 1024 / 1024).toFixed(fractionDigits);
}

export function byteArrayToBuffer(array: Uint8Array): ArrayBuffer {
  return array.buffer.slice(array.byteOffset, array.byteLength + array.byteOffset);
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
