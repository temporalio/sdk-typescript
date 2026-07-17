import type { AsyncLocalStorage as ALS } from 'node:async_hooks';
import type { temporal, coresdk } from '@temporalio/proto';
import { convertOptionalToPayload } from '@temporalio/common/lib/converter/payload-converter';
import type { SerializationContext } from '@temporalio/common/lib/converter/serialization-context';
import { AsyncLocalStorage } from './cancellation-scope';
import { assertInWorkflowContext, getActivator } from './global-attributes';
import { sha1Hex } from './sha1';

// FIXME(JWH): Will these survive V8 serialization?
// FIXME(JWH): Alternatively, we could add a dev dependency to the 'long' package...
type Long = coresdk.workflow_activation.ISignalWorkflow['originatingEventId'];

/**
 * Stack of group markers active in the current execution scope. Pushed onto by
 * {@link GroupMarkerImpl.run}, read by {@link mergeActiveGroupMarkers} at command-emission time.
 */
const activeMarkersStorage: ALS<readonly EventGroupMarker[]> = new AsyncLocalStorage();

/**
 * Workflow-internal implementation of {@link EventGroupMarker}.
 *
 * This class is intentionally not exported: end-users only ever see the structural
 * {@link EventGroupMarker} interface (from `@temporalio/common`), and can only obtain explicit
 * marker instances through {@link createEventGroup}. Implicit markers are created by the SDK at
 * activation dispatch sites via {@link createInboundEventMarker} and are never handed back
 * to user code as a value.
 *
 * The two variants (`label` for explicit, `inboundEventId` for implicit) are mutually
 * exclusive; exactly one is populated on any given instance.
 */
class GroupMarkerImpl implements EventGroupMarker {
  public readonly label?: string;
  public readonly inboundEventId?: Long;
  public readonly inboundUpdateId?: string;

  private constructor(
    public readonly id: string,
    init: { label: string } | { inboundEventId: Long } | { inboundUpdateId: string }
  ) {
    if ('label' in init) {
      this.label = init.label;
    } else if ('inboundEventId' in init) {
      this.inboundEventId = init.inboundEventId;
    } else {
      this.inboundUpdateId = init.inboundUpdateId;
    }
  }

  static withLabel(label: string, options: { id?: string; runId: string }): GroupMarkerImpl {
    // When the workflow author doesn't provide an explicit `id`, derive a deterministic, replay-stable
    // one from the label. The run id acts as a salt so that the same label in different workflow
    // executions yields different ids, and to mitigate brute-force recovery of the label from the id.
    const id = options.id ?? sha1Hex(`${options.runId}${label}`);
    return new GroupMarkerImpl(id, { label });
  }

  static withInboundEventId(eventId: Long): GroupMarkerImpl {
    if (eventId == null || eventId.toNumber() === 0) throw new Error('Invalid event ID');
    // Deterministic, short, opaque. Stable across replays because event IDs are part of
    // the recorded history; the same inbound event always yields the same `id`.
    return new GroupMarkerImpl(`e${eventId}`, { inboundEventId: eventId });
  }

  static withInboundUpdateId(updateId: string): GroupMarkerImpl {
    // Update IDs are workflow-unique and durable across replays.
    return new GroupMarkerImpl(`u${updateId}`, { inboundUpdateId: updateId });
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    assertInWorkflowContext('GroupMarker.run(...) may only be used from a Workflow Execution');
    const outer = activeMarkersStorage.getStore() ?? [];
    return activeMarkersStorage.run([...outer, this], fn);
  }
}

/**
 * Create a new event group marker that can be attached to commands scheduled by this workflow.
 *
 * The returned marker has a freshly-generated identifier (workflow-deterministic). Attach it
 * to any number of commands (activities, child workflows, timers, etc.) via their `groups`
 * option, or implicitly via {@link EventGroupMarker.run}, to indicate that those commands belong
 * to the same logical group.
 *
 * @param label a user-visible label for the group, surfaced in the UI / CLI
 *
 * @experimental Event Groups is a new API and may change without notice.
 */
export function createEventGroup(label: string, options?: { id?: string }): EventGroupMarker {
  const activator = assertInWorkflowContext('createGroup(...) may only be used from a Workflow Execution');
  // Salt the derived id with `originalExecutionRunId` (the run id from the `WorkflowExecutionStarted`
  // event, preserved across resets) so the same label yields a stable id across replays and resets,
  // while differing between distinct workflow executions.
  return GroupMarkerImpl.withLabel(label, { id: options?.id, runId: activator.info.originalExecutionRunId });
}

/**
 * Create an implicit group marker referencing a specific history event by ID. Used by the
 * SDK at the dispatch points for workflow start and signal handlers; never exposed to user
 * code.
 *
 * @internal
 */
export function createInboundEventMarker(eventId: Long | null | undefined): EventGroupMarker {
  if (eventId == null || eventId.toNumber() === 0) throw new Error('Invalid event ID');
  return GroupMarkerImpl.withInboundEventId(eventId);
}

/**
 * Create an implicit group marker referencing an inbound update by its workflow-unique
 * identifier. Used by the SDK at the update-handler dispatch point; never exposed to user
 * code.
 *
 * @internal
 */
export function createInboundUpdateMarker(updateId: string): EventGroupMarker {
  return GroupMarkerImpl.withInboundUpdateId(updateId);
}

/**
 * Run `fn` with EXACTLY the given implicit marker active, ignoring any markers in the outer
 * ALS context. Used at inbound activation dispatch sites (workflow start, signal handler,
 * update handler) to ensure that the synchronous portion of handler bodies doesn't pick up
 * residual ALS state from a previously-resumed coroutine (e.g., the workflow main function's
 * continuation, which still has its own implicit marker alive in its async chain).
 *
 * Inside `fn`, explicit `marker.run(...)` continues to nest normally.
 *
 * @internal
 */
export function runInIsolatedImplicitScope<T>(implicitMarker: EventGroupMarker, fn: () => Promise<T>): Promise<T> {
  return activeMarkersStorage.run([implicitMarker], fn);
}

/**
 * Merge the markers currently active in the execution scope with any explicitly-attached
 * markers, deduplicating by `id`. Scope markers come first, followed by explicit markers that
 * are not already present in the scope. Returns `undefined` when neither source produces any
 * marker.
 */
function mergeActiveGroupMarkers(
  explicit: readonly EventGroupMarker[] | undefined
): readonly EventGroupMarker[] | undefined {
  const scope = activeMarkersStorage.getStore();
  if ((scope == null || scope.length === 0) && (explicit == null || explicit.length === 0)) {
    return undefined;
  }
  if (scope == null || scope.length === 0) return explicit;
  if (explicit == null || explicit.length === 0) return scope;

  const seen = new Set<string>(scope.map((m) => m.id));
  const merged: EventGroupMarker[] = [...scope];
  for (const marker of explicit) {
    if (!seen.has(marker.id)) {
      seen.add(marker.id);
      merged.push(marker);
    }
  }
  return merged;
}

/**
 * A discrete token used to associate workflow commands (and the corresponding history events)
 * with a logical "group" for UI/observability purposes. Multiple group markers may be attached
 * to a single command, and a single marker may be attached to multiple commands.
 *
 * Group markers are obtained from {@link createEventGroup} in the `@temporalio/workflow` package.
 * The concrete implementation type is not part of the public API; consumers should treat
 * `GroupMarker` as an opaque value.
 *
 * @experimental Event Groups is a new API and may change without notice.
 */
export interface EventGroupMarker {
  /**
   * Opaque identifier assigned by the SDK when the marker was created. Two `GroupMarker`
   * instances are considered to refer to the same group if and only if their `id` matches.
   */
  // FIXME: We probably don't need to expose this to the public API.
  readonly id: string;

  /**
   * Optional user-visible label. Present for markers created via `createGroup(label)`.
   * Absent for implicit markers (which use {@link inboundEventId} or {@link inboundUpdateId}
   * instead).
   *
   * Mutually exclusive with {@link inboundEventId} and {@link inboundUpdateId}.
   */
  readonly label?: string;

  /**
   * Run `fn` in a scope in which this marker is implicitly attached to every command produced
   * by the workflow code that executes within. Marker scopes nest: when called from within
   * another marker's `run`, all outer markers remain attached as well.
   *
   * Only callable from a Workflow Execution.
   *
   * @experimental Event Groups is a new API and may change without notice.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Merge the explicitly-attached markers with those active in the current execution scope and
 * serialize the result into the proto form attached to a workflow command.
 *
 * The payload converter is obtained from the current workflow's {@link Activator}; this function
 * is inherently workflow-context-bound (it also reads the active-scope markers from AsyncLocalStorage)
 * and may only be called from within a Workflow Execution.
 *
 * Returns `undefined` if no marker ends up attached, so the caller can omit the `eventGroupMarkers`
 * field from the outgoing command altogether (matching the convention used for `userMetadata`).
 *
 * Each marker is encoded as one of the `EventGroupMarker.variant` cases: the `label` variant
 * (for explicit markers created via `createGroup`), the `inboundEvent` variant, or the
 * `inboundUpdate` variant (for implicit markers created by the SDK around inbound activations).
 *
 * The SDK `id` is only carried on the wire for the `label` variant. For inbound variants it is
 * derivable from `inboundEventId` / `inboundUpdateId`, so it is omitted.
 *
 * @internal
 */
export function eventGroupMarkersToProto(
  explicit: readonly EventGroupMarker[] | undefined,
  context?: SerializationContext
): temporal.api.sdk.v1.IEventGroupMarker[] | undefined {
  const groups = mergeActiveGroupMarkers(explicit) as readonly GroupMarkerImpl[] | undefined;
  if (groups == null || groups.length === 0) return undefined;

  const { payloadConverter } = getActivator();
  return groups.map((marker) => {
    if (marker.inboundEventId != null) {
      return {
        inboundEvent: { inboundEventId: marker.inboundEventId },
      };
    }
    if (marker.inboundUpdateId != null) {
      return {
        inboundUpdate: { inboundUpdateId: marker.inboundUpdateId },
      };
    }
    return {
      label: { id: marker.id, label: convertOptionalToPayload(payloadConverter, marker.label, context) },
    };
  });
}
