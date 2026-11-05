import { convertDeploymentVersion } from '@temporalio/common';
import { suggestContinueAsNewReasonsFromProto } from '@temporalio/common/internal/internal-non-workflow';
import { tsToMs } from '@temporalio/common/lib/time';
import type { coresdk } from '@temporalio/proto';
import { type Activator, SdkFlags } from '@temporalio/workflow/internal';

/** State preparation shared by executors; does not enter a realm or schedule work. */
export function prepareNonQueryActivation(
  activator: Activator,
  activation: coresdk.workflow_activation.IWorkflowActivation
): void {
  if (activation.timestamp == null)
    throw new TypeError('Expected activation.timestamp to be set for non-query activation');
  activator.now = tsToMs(activation.timestamp);
  activator.checkConditions = activation.jobs!.some(({ doUpdate }) => doUpdate == null);
  activator.mutateWorkflowInfo((info) => ({
    ...info,
    historyLength: activation.historyLength as number,
    historySize: activation.historySizeBytes?.toNumber() ?? 0,
    continueAsNewSuggested: activation.continueAsNewSuggested ?? false,
    targetWorkerDeploymentVersionChanged: activation.targetWorkerDeploymentVersionChanged ?? false,
    suggestedContinueAsNewReasons: suggestContinueAsNewReasonsFromProto(activation.suggestContinueAsNewReasons),
    currentBuildId: activation.deploymentVersionForCurrentTask?.buildId ?? '',
    currentDeploymentVersion: convertDeploymentVersion(activation.deploymentVersionForCurrentTask),
    unsafe: {
      ...info.unsafe,
      isReplaying: activation.isReplaying ?? false,
      isReplayingHistoryEvents: activation.isReplaying ?? false,
    },
  }));
  activator.addKnownFlags(activation.availableInternalFlags ?? []);
  if (activation.lastSdkVersion) activator.sdkVersion = activation.lastSdkVersion;
}

/** Preserve historical signal batching and patch/seed ordering in every executor. */
export function prepareActivationBatches(
  activator: Activator,
  jobs: coresdk.workflow_activation.IWorkflowActivationJob[]
): coresdk.workflow_activation.IWorkflowActivationJob[][] {
  const hasSignals = jobs.some(({ signalWorkflow }) => signalWorkflow != null);
  const singleBatch = !hasSignals || activator.hasFlag(SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch);
  const [patches, nonPatches] = partition(jobs, ({ notifyHasPatch }) => notifyHasPatch != null);
  for (const { notifyHasPatch } of patches) {
    if (notifyHasPatch == null) throw new TypeError('Expected notifyHasPatch to be set');
    activator.notifyHasPatch(notifyHasPatch);
  }
  if (singleBatch) {
    // Before the single-batch flag, seed updates were regular jobs. Preserve that
    // ordering on replay rather than moving them ahead of the signal batch.
    const [seeds, rest] = partition(nonPatches, ({ updateRandomSeed }) => updateRandomSeed != null);
    if (seeds.length) activator.updateRandomSeed(seeds[seeds.length - 1]!.updateRandomSeed!);
    return [rest];
  }
  return partition(nonPatches, ({ signalWorkflow }) => signalWorkflow != null).filter((batch) => batch.length > 0);
}

export function partition<T>(arr: T[], predicate: (value: T) => boolean): [T[], T[]] {
  const truthy: T[] = [],
    falsy: T[] = [];
  for (const value of arr) (predicate(value) ? truthy : falsy).push(value);
  return [truthy, falsy];
}
