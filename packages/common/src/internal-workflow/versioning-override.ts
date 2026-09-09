import { temporal } from '@temporalio/proto';
import { toCanonicalString, type VersioningOverride } from '../worker-deployments';

/** @internal */
export function versioningOverrideToProto(
  versioningOverride: VersioningOverride | undefined
): temporal.api.workflow.v1.IVersioningOverride | undefined {
  if (versioningOverride == null) {
    return undefined;
  }
  // TODO: Remove deprecated field assignments when versioning is non-experimental.
  if (versioningOverride === 'AUTO_UPGRADE') {
    return {
      autoUpgrade: true,
      behavior: temporal.api.enums.v1.VersioningBehavior.VERSIONING_BEHAVIOR_AUTO_UPGRADE,
    };
  }
  return {
    pinned: {
      version: versioningOverride.pinnedTo,
      behavior: temporal.api.workflow.v1.VersioningOverride.PinnedOverrideBehavior.PINNED_OVERRIDE_BEHAVIOR_PINNED,
    },
    behavior: temporal.api.enums.v1.VersioningBehavior.VERSIONING_BEHAVIOR_PINNED,
    pinnedVersion: toCanonicalString(versioningOverride.pinnedTo),
  };
}
