import type { coresdk } from '@temporalio/proto';
import type { VersioningIntent as VersioningIntentString } from './versioning-intent';
import { assertNever, checkExtends } from './type-helpers';

/* eslint-disable deprecation/deprecation */

// Avoid importing the proto implementation to reduce workflow bundle size
// Copied from coresdk.common.VersioningIntent
/**
 * Protobuf enum representation of {@link VersioningIntentString}.
 *
 * @deprecated Worker Versioning is now deprecated. Please use the Worker Deployment API instead: https://docs.temporal.io/worker-deployments
 */
export enum VersioningIntent {
  UNSPECIFIED = 0,
  COMPATIBLE = 1,
  DEFAULT = 2,
}

checkExtends<coresdk.common.VersioningIntent, VersioningIntent>();
checkExtends<VersioningIntent, coresdk.common.VersioningIntent>();

/**
 * @deprecated Worker Versioning is now deprecated. Please use the Worker Deployment API instead: https://docs.temporal.io/worker-deployments
 */
export function versioningIntentToProto(intent: VersioningIntentString | undefined): VersioningIntent {
  switch (intent) {
    case 'DEFAULT':
      return VersioningIntent.DEFAULT;
    case 'COMPATIBLE':
      return VersioningIntent.COMPATIBLE;
    case undefined:
      return VersioningIntent.UNSPECIFIED;
    default:
      assertNever('Unexpected VersioningIntent', intent);
  }
}
