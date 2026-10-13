/**
 * Which Nexus endpoints the integration tests need, and how a test finds its endpoint.
 *
 * Locally, `registerNexusEndpoint()` creates each endpoint through the OperatorService. Temporal Cloud only allows
 * endpoint management through the Cloud Ops API, and new endpoints take minutes to propagate. So for Cloud runs,
 * `.github/scripts/cloud-namespace.ts` creates every endpoint in the manifest up front, and tests compute the name
 * of their endpoint instead of creating it.
 */
// Bare specifiers: test files bundle this module into workflow code, and the bundler ignores these.
import { createHash } from 'crypto';
import { basename } from 'path';
import { nexusEndpointManifest } from './nexus-endpoint-manifest';

/** Set when endpoints were created before the run; their names start with this prefix. */
export const NEXUS_ENDPOINT_PREFIX_ENV = 'TEMPORAL_TEST_NEXUS_ENDPOINT_PREFIX';

/**
 * Manifest key for a test file path or `file:` URL: the file name without suffixes such as `.cloud-unavailable`, or
 * extension.
 */
export function nexusSuiteName(testFile: string): string {
  return basename(testFile).split('.')[0];
}

/**
 * Name of the pre-created endpoint that routes to `taskQueue`. Task queues come from test titles, which are too
 * long and loosely formatted to use in endpoint names directly.
 */
export function preCreatedNexusEndpointName(prefix: string, taskQueue: string): string {
  return `${prefix}-${createHash('sha256').update(taskQueue).digest('hex').slice(0, 16)}`;
}

/** Fail unless the manifest lists `taskQueue` for `testFile`, so that every server a test runs on has its endpoint. */
export function assertNexusEndpointInManifest(testFile: string, taskQueue: string): void {
  const suite = nexusSuiteName(testFile);
  if (!nexusEndpointManifest[suite]?.includes(taskQueue)) {
    throw new Error(
      `Task queue '${taskQueue}' is missing from the Nexus endpoint manifest. ` +
        `Add it under '${suite}' in packages/test/src/nexus-endpoint-manifest.ts so that Cloud runs create its endpoint.`
    );
  }
}

/** Task queues that need an endpoint when running `testFiles`. */
export function nexusEndpointTaskQueues(testFiles: readonly string[]): string[] {
  const taskQueues = new Set<string>();
  for (const testFile of testFiles) {
    for (const taskQueue of nexusEndpointManifest[nexusSuiteName(testFile)] ?? []) taskQueues.add(taskQueue);
  }
  return [...taskQueues].sort();
}
