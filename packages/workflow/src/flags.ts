import type { WorkflowInfo } from './interfaces';

export type SdkFlag = {
  get id(): number;
  get default(): boolean;
  get alternativeConditions(): AltConditionFn[] | undefined;
};

const flagsRegistry: Map<number, SdkFlag> = new Map();

export const SdkFlags = {
  /**
   * This flag gates multiple fixes related to cancellation scopes and timers introduced in 1.10.2/1.11.0:
   * - Cancellation of a non-cancellable scope no longer propagates to children scopes
   *   (see https://github.com/temporalio/sdk-typescript/issues/1423).
   * - CancellationScope.withTimeout(fn) now cancel the timer if `fn` completes before expiration
   *   of the timeout, similar to how `condition(fn, timeout)` works.
   * - Timers created using setTimeout can now be intercepted.
   *
   * @since Introduced in 1.10.2/1.11.0. However, due to an SDK bug, SDKs v1.11.0 and v1.11.1 were not
   *        properly writing back the flags to history, possibly resulting in NDE on replay. We therefore
   *        consider that a WFT emitted by Worker v1.11.0 or v1.11.1 to implicitly have this flag on.
   */
  NonCancellableScopesAreShieldedFromPropagation: defineFlag(1, true, [buildIdSdkVersionMatches(/1\.11\.[01]/)]),

  /**
   * Prior to 1.11.0, when processing a Workflow activation, the SDK would execute `notifyHasPatch`
   * and `signalWorkflow` jobs in distinct phases, before other types of jobs. The primary reason
   * behind that multi-phase algorithm was to avoid the possibility that a Workflow execution might
   * complete before all incoming signals have been dispatched (at least to the point that the
   * _synchronous_ part of the handler function has been executed).
   *
   * This flag replaces that multi-phase algorithm with a simpler one where jobs are simply sorted as
   * `(signals and updates) -> others`, but without processing them as distinct batches (i.e. without
   * leaving/reentering the VM context between each group, which automatically triggers the execution
   * of all outstanding microtasks). That single-phase approach resolves a number of quirks of the
   * former algorithm, and yet still satisfies to the original requirement of ensuring that every
   * `signalWorkflow` jobs - and now `doUpdate` jobs as well - have been given a proper chance to
   * execute before the Workflow main function might completes.
   *
   * @since Introduced in 1.11.0. This change is not rollback-safe. However, due to an SDK bug, SDKs
   *        v1.11.0 and v1.11.1 were not properly writing back the flags to history, possibly resulting
   *        in NDE on replay. We therefore consider that a WFT emitted by Worker v1.11.0 or v1.11.1
   *        to implicitely have this flag on.
   */
  ProcessWorkflowActivationJobsAsSingleBatch: defineFlag(2, true, [buildIdSdkVersionMatches(/1\.11\.[01]/)]),
  /**
   * In 1.11.3 and previous versions, the interceptor for `handleSignal` provided
   * by @temporalio/interceptors-opentelemetry did not have a yield point in it.
   * A yield point was accidentally added in later versions. This added yield point
   * can cause NDE if there was a signal handler and the workflow was started with a signal.
   *
   * This yield point was removed in 1.13.2, but in order to prevent workflows from the
   * affected versions resulting in NDE, we have to inject the yield point on replay.
   * This flag should be enabled for SDK versions newer than 1.11.3 or older than 1.13.2.
   *
   * @since Introduced in 1.13.2.
   */
  OpenTelemetryHandleSignalInterceptorInsertYield: defineFlag(3, false, [
    isBetween({ major: 1, minor: 11, patch: 3 }, { major: 1, minor: 13, patch: 2 }),
  ]),
  /**
   * The interceptors provided by @temporalio/interceptors-opentelemetry initially had unnecessary yield points.
   * If replaying a workflow created from these versions a yield point is injected to prevent any NDE.
   *
   * @since Introduced in 1.13.2
   */
  OpenTelemetryInterceptorInsertYield: defineFlag(3, false, [isBefore({ major: 1, minor: 13, patch: 2 })]),
} as const;

function defineFlag(id: number, def: boolean, alternativeConditions?: AltConditionFn[]): SdkFlag {
  const flag = { id, default: def, alternativeConditions };
  flagsRegistry.set(id, flag);
  return flag;
}

export function assertValidFlag(id: number): void {
  if (!flagsRegistry.has(id)) throw new TypeError(`Unknown SDK flag: ${id}`);
}

/**
 * An SDK Flag Alternate Condition provides an alternative way of determining whether a flag
 * should be considered as enabled for the current WFT; e.g. by looking at the version of the SDK
 * that emitted a WFT. The main use case for this is to retroactively turn on some flags for WFT
 * emitted by previous SDKs that contained a bug.
 *
 * Note that conditions are only evaluated while replaying, and only if the corresponing flag is
 * not already set. Also, alternate conditions will not cause the flag to be persisted to the
 * "used flags" set, which means that further Workflow Tasks may not reflect this flag if the
 * condition no longer holds. This is so to avoid incorrect behaviors in case where a Workflow
 * Execution has gone through a newer SDK version then again through an older one.
 */
type AltConditionFn = (ctx: { info: WorkflowInfo; sdkVersion?: string }) => boolean;

function buildIdSdkVersionMatches(version: RegExp): AltConditionFn {
  const regex = new RegExp(`^@temporalio/worker@(${version.source})[+]`);
  return ({ info }) => info.currentBuildId != null && regex.test(info.currentBuildId); // eslint-disable-line deprecation/deprecation
}

type SemVer = {
  major: number;
  minor: number;
  patch: number;
};

function parseSemver(version: string): SemVer | undefined {
  const matches = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!matches) return undefined;
  const [full, major, minor, patch] = matches.map((digits) => {
    try {
      return Number.parseInt(digits);
    } catch {
      return undefined;
    }
  });
  if (major === undefined || minor === undefined || patch === undefined)
    throw new Error(`full: ${full}, parts: ${major}.${minor}.${patch}`);
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return {
    major,
    minor,
    patch,
  };
}

function compareSemver(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major < b.major) return -1;
  if (a.major > b.major) return 1;
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  if (a.patch < b.patch) return -1;
  if (a.patch > b.patch) return 1;
  return 0;
}

function isCompared(compare: SemVer, comparison: -1 | 0 | 1): AltConditionFn {
  return ({ sdkVersion }) => {
    if (!sdkVersion) throw new Error('no sdk version');
    if (!sdkVersion) return false;
    const version = parseSemver(sdkVersion);
    if (!version) throw new Error(`no version for ${sdkVersion}`);
    if (!version) return false;
    return compareSemver(compare, version) === comparison;
  };
}

function isBefore(compare: SemVer): AltConditionFn {
  return isCompared(compare, 1);
}

function isEqual(compare: SemVer): AltConditionFn {
  return isCompared(compare, 0);
}

function isAfter(compare: SemVer): AltConditionFn {
  return isCompared(compare, -1);
}

function isBetween(lowEnd: SemVer, highEnd: SemVer): AltConditionFn {
  return (ctx) => isAfter(lowEnd)(ctx) && isBefore(highEnd)(ctx);
}
