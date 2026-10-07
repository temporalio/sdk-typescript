import test from 'ava';
import { temporal } from '@temporalio/proto';
import { versioningOverrideToProto } from '../worker-deployments';

const version = { deploymentName: 'deployment', buildId: 'build' };
const { PinnedOverrideBehavior } = temporal.api.workflow.v1.VersioningOverride;

test('versioning overrides encode pinned, auto-upgrade, one-time, and absent configurations', (t) => {
  t.is(versioningOverrideToProto(undefined), undefined);
  t.deepEqual(versioningOverrideToProto({ pinnedTo: version }), {
    pinned: { version, behavior: PinnedOverrideBehavior.PINNED_OVERRIDE_BEHAVIOR_PINNED },
  });
  t.deepEqual(versioningOverrideToProto('AUTO_UPGRADE'), { autoUpgrade: true });
  t.deepEqual(versioningOverrideToProto({ oneTimeTo: version }), {
    oneTime: { targetDeploymentVersion: version },
  });
});
