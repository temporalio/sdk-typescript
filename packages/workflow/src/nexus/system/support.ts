import * as common from '@temporalio/common';
import { msToTs, requiredTsToMs } from '@temporalio/common/time';
import { currentSystemNexusPayloadConversion } from '@temporalio/common/internal/nexus';
import {
  decodeTypedSearchAttributes,
  encodeUnifiedSearchAttributes,
} from '@temporalio/common/internal/internal-workflow';
import type { google, temporal } from '@temporalio/proto';
import { workflowInfo } from '../../workflow';
import type { SignalWithStartWorkflowRequest } from './generated/models';

export { valueToPayload, payloadToValue } from '@temporalio/common/internal/nexus';
/** @lintignore Nexgen support hooks not used by the current Workflow service models. */
export { failureFromProto, failureToProto } from '@temporalio/common/internal/nexus';

export function retryPolicyFromProto(proto: temporal.api.common.v1.IRetryPolicy): common.RetryPolicy {
  return common.decompileRetryPolicy(proto)!;
}

export function retryPolicyToProto(retryPolicy: common.RetryPolicy): temporal.api.common.v1.IRetryPolicy {
  return common.compileRetryPolicy(retryPolicy);
}

export function workflowTypeFromProto(proto: temporal.api.common.v1.IWorkflowType): string {
  return proto.name ?? '';
}

export function workflowTypeToProto(workflowType: string | common.Workflow): temporal.api.common.v1.IWorkflowType {
  return { name: workflowFunctionName(workflowType) };
}

export function workflowFunctionName(value: string | common.Workflow): string {
  return typeof value === 'string' ? value : common.extractWorkflowType(value);
}

export function signalFunctionName(value: string | common.SignalDefinition<any[]>): string {
  return typeof value === 'string' ? value : value.name;
}

export function functionInputTypes(value: unknown): readonly common.TypeInfo[] | undefined {
  if (typeof value === 'function') {
    return common.extractWorkflowTypeAndConfig(value as common.Workflow).typeInfo?.inputTypes;
  }
  if (typeof value === 'object' && value !== null) {
    return (value as common.SignalDefinition<any[]>).typeInfo?.inputTypes;
  }
  return undefined;
}

export function taskQueueFromProto(proto: temporal.api.taskqueue.v1.ITaskQueue): string {
  return proto.name ?? '';
}

export function taskQueueToProto(taskQueue: string): temporal.api.taskqueue.v1.ITaskQueue {
  return { name: taskQueue };
}

export function workflowNamespace(): string {
  return workflowInfo().namespace;
}

/** Serialization context for payloads owned by a signal-with-start target workflow. */
export function signalWithStartWorkflowSerializationContext(
  request: SignalWithStartWorkflowRequest
): common.WorkflowSerializationContext {
  return {
    type: 'workflow',
    namespace: request.namespace ?? workflowInfo().namespace,
    workflowId: request.id,
  };
}

export function payloadFromProto(payload: temporal.api.common.v1.IPayload): common.Payload {
  return payload;
}

export function payloadToProto(payload: common.Payload): temporal.api.common.v1.IPayload {
  return payload;
}

/** Convert application values to the protobuf payload-list representation. */
export function payloadsToProto(
  values: ReadonlyArray<unknown>,
  typeInfo?: readonly common.TypeInfo[]
): temporal.api.common.v1.IPayloads {
  const { converter, context } = currentSystemNexusPayloadConversion();
  return { payloads: common.toPayloadsWithContext(converter, context, [...values], typeInfo) ?? [] };
}

/** Convert a protobuf payload-list representation to application values. */
export function payloadsFromProto(proto: temporal.api.common.v1.IPayloads): unknown[] {
  const { converter, context } = currentSystemNexusPayloadConversion();
  return common.arrayFromPayloads(converter, proto.payloads, context) ?? [];
}

export function memoFromProto(proto: temporal.api.common.v1.IMemo): Record<string, unknown> {
  const { converter, context } = currentSystemNexusPayloadConversion();
  return common.mapFromPayloads(converter, proto.fields ?? undefined, context) ?? {};
}

export function memoToProto(memo: Record<string, unknown>): temporal.api.common.v1.IMemo {
  const { converter, context } = currentSystemNexusPayloadConversion();
  return {
    fields: common.mapToPayloads(converter, memo, context),
  };
}

export function headerFromProto(proto: temporal.api.common.v1.IHeader): Record<string, unknown> {
  const { converter, context } = currentSystemNexusPayloadConversion();
  return common.mapFromPayloads(converter, proto.fields, context) ?? {};
}

export function headerToProto(header: Record<string, unknown>): temporal.api.common.v1.IHeader {
  const { converter, context } = currentSystemNexusPayloadConversion();
  return { fields: common.mapToPayloads(converter, header, context) };
}

export function durationFromProto(proto: google.protobuf.IDuration): common.Duration {
  return requiredTsToMs(proto, 'duration');
}

export function durationToProto(duration: common.Duration): google.protobuf.IDuration {
  return msToTs(duration);
}

export function searchAttributesFromProto(
  proto: temporal.api.common.v1.ISearchAttributes
): common.TypedSearchAttributes {
  return decodeTypedSearchAttributes(proto.indexedFields);
}

export function searchAttributesToProto(
  searchAttributes: common.TypedSearchAttributes
): temporal.api.common.v1.ISearchAttributes {
  return {
    indexedFields: encodeUnifiedSearchAttributes(undefined, searchAttributes),
  };
}

export function priorityFromProto(proto: temporal.api.common.v1.IPriority): common.Priority {
  return common.decodePriority(proto);
}

export function priorityToProto(priority: common.Priority): temporal.api.common.v1.IPriority {
  return common.compilePriority(priority);
}

const VERSIONING_BEHAVIOR_AUTO_UPGRADE = 2;

export function versioningOverrideFromProto(
  proto: temporal.api.workflow.v1.IVersioningOverride
): common.VersioningOverride | undefined {
  if (proto.autoUpgrade || proto.behavior === VERSIONING_BEHAVIOR_AUTO_UPGRADE) {
    return 'AUTO_UPGRADE';
  }
  const oneTimeVersion = proto.oneTime?.targetDeploymentVersion;
  if (oneTimeVersion?.deploymentName != null && oneTimeVersion.buildId != null) {
    return {
      oneTimeTo: {
        deploymentName: oneTimeVersion.deploymentName,
        buildId: oneTimeVersion.buildId,
      },
    };
  }
  const pinnedVersion = proto.pinned?.version;
  if (pinnedVersion?.deploymentName != null && pinnedVersion.buildId != null) {
    return {
      pinnedTo: {
        deploymentName: pinnedVersion.deploymentName,
        buildId: pinnedVersion.buildId,
      },
    };
  }
  if (proto.deployment?.seriesName != null && proto.deployment.buildId != null) {
    return {
      pinnedTo: {
        deploymentName: proto.deployment.seriesName,
        buildId: proto.deployment.buildId,
      },
    };
  }
  return undefined;
}

export function versioningOverrideToProto(
  versioningOverride: common.VersioningOverride
): temporal.api.workflow.v1.IVersioningOverride {
  return common.versioningOverrideToProto(versioningOverride)!;
}

export function workflowIdReusePolicyFromProto(
  policy: temporal.api.enums.v1.WorkflowIdReusePolicy
): common.WorkflowIdReusePolicy | undefined {
  return common.decodeWorkflowIdReusePolicy(policy);
}

export function workflowIdReusePolicyToProto(
  policy: common.WorkflowIdReusePolicy
): temporal.api.enums.v1.WorkflowIdReusePolicy | undefined {
  return common.encodeWorkflowIdReusePolicy(policy);
}

export function workflowIdConflictPolicyFromProto(
  policy: temporal.api.enums.v1.WorkflowIdConflictPolicy
): common.WorkflowIdConflictPolicy | undefined {
  return common.decodeWorkflowIdConflictPolicy(policy);
}

export function workflowIdConflictPolicyToProto(
  policy: common.WorkflowIdConflictPolicy
): temporal.api.enums.v1.WorkflowIdConflictPolicy | undefined {
  return common.encodeWorkflowIdConflictPolicy(policy);
}
