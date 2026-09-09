import * as common from '@temporalio/common';
import { msToTs, requiredTsToMs } from '@temporalio/common/lib/time';
import {
  decodeTypedSearchAttributes,
  encodeUnifiedSearchAttributes,
} from '@temporalio/common/lib/converter/payload-search-attributes';
import {
  versioningOverrideToProto as commonVersioningOverrideToProto,
} from '@temporalio/common/lib/internal-workflow';
import type { google, temporal } from '@temporalio/proto';
import { workflowInfo } from '../../../workflow';
import { currentSystemNexusUserPayloadConverter } from '../user-payload-converter';
import type { SignalWithStartWorkflowRequest } from './models';

export function retryPolicyFromProto(proto: temporal.api.common.v1.IRetryPolicy): common.RetryPolicy {
  return common.decompileRetryPolicy(proto)!;
}

export function retryPolicyToProto(retryPolicy: common.RetryPolicy): temporal.api.common.v1.IRetryPolicy {
  return common.compileRetryPolicy(retryPolicy);
}

export function workflowTypeFromProto(proto: temporal.api.common.v1.IWorkflowType): string | common.Workflow {
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

function configuredPayloadConverter(): common.PayloadConverter {
  return currentSystemNexusUserPayloadConverter();
}

/** Convert application values to the protobuf payload-list representation. */
export function payloadsToProto(values: ReadonlyArray<unknown>): temporal.api.common.v1.IPayloads {
  return { payloads: common.toPayloads(configuredPayloadConverter(), ...values) ?? [] };
}

/** Convert a protobuf payload-list representation to application values. */
export function payloadsFromProto(proto: temporal.api.common.v1.IPayloads): unknown[] {
  return common.arrayFromPayloads(configuredPayloadConverter(), proto.payloads) ?? [];
}

/** Convert one application value to a protobuf payload. */
export function valueToPayload(value: unknown): common.Payload {
  return configuredPayloadConverter().toPayload(value);
}

/** Convert one protobuf payload to an application value. */
export function payloadToValue<T>(payload: common.Payload): T {
  return configuredPayloadConverter().fromPayload<T>(payload);
}

export function failureFromProto(proto: temporal.api.failure.v1.IFailure): Error {
  return common.defaultFailureConverter.failureToError(proto, configuredPayloadConverter());
}

export function failureToProto(failure: Error): temporal.api.failure.v1.IFailure {
  return common.defaultFailureConverter.errorToFailure(failure, configuredPayloadConverter());
}

export function memoFromProto(proto: temporal.api.common.v1.IMemo): Record<string, unknown> {
  return common.mapFromPayloads(configuredPayloadConverter(), proto.fields ?? undefined) ?? {};
}

export function memoToProto(memo: Record<string, unknown>): temporal.api.common.v1.IMemo {
  return {
    fields: common.mapToPayloads(configuredPayloadConverter(), memo),
  };
}

export function headerFromProto(proto: temporal.api.common.v1.IHeader): Record<string, unknown> {
  return common.mapFromPayloads(configuredPayloadConverter(), proto.fields) ?? {};
}

export function headerToProto(header: Record<string, unknown>): temporal.api.common.v1.IHeader {
  return { fields: common.mapToPayloads(configuredPayloadConverter(), header) };
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
  return commonVersioningOverrideToProto(versioningOverride)!;
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
