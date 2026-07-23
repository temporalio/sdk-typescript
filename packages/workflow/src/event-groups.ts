import type { AsyncLocalStorage as ALS } from 'node:async_hooks';
import type Long from 'long';
import type { temporal } from '@temporalio/proto';
import type { PayloadConverter } from '@temporalio/common/lib/converter/payload-converter';
import type { SerializationContext } from '@temporalio/common/lib/converter/serialization-context';
import type { ReplaceNested } from '@temporalio/common/lib/type-helpers';
import { deepMerge } from '@temporalio/common/lib/internal-workflow';
import { AsyncLocalStorage } from './cancellation-scope';
import { assertInWorkflowContext, getActivator } from './global-attributes';
import { sha1Hex } from './sha1';

// Same as IEventGroupMarker, but with strings instead of Payloads
type IUnconvertedEventGroupMarker = ReplaceNested<
  temporal.api.sdk.v1.IEventGroupMarker,
  temporal.api.common.v1.IPayload,
  string
>;

/**
 * A discrete token used to associate workflow commands (and the corresponding history events)
 * with a logical "group" for UI/observability purposes. Multiple event group markers may be
 * attached to a single command, and a single marker may be attached to multiple commands.
 *
 * Event group markers are created using {@link createEventGroup}.
 *
 * @experimental Event Groups is an experimental API and may change without notice.
 */
export interface EventGroupMarker {
  /**
   * Run `fn` in a scope in which this event group marker is implicitly attached to every command
   * produced by the workflow code that executes within. Event Group scopes nest: when called from
   * within another event group marker's `withScope`, all outer markers remain attached as well.
   *
   * Only callable from a Workflow Execution.
   *
   * @experimental Event Groups is an experimental API and may change without notice.
   */
  withScope<T>(fn: () => Promise<T>): Promise<T>;
}

/** Active event group markers in the current execution scope. */
const activeMarkerScopes: ALS<ActiveMarkerScopes> = new AsyncLocalStorage();

interface ActiveMarkerScopes {
  /**
   * The active implicit event group marker.
   *
   * There's only one active implicit event group marker scope at any point in time, corresponding
   * to the inbound workflow event that triggered execution of the current handler (i.e. one of
   * WorkflowExecutionStarted, WorkflowExecutionSignaled or WorkflowExecutionUpdated).
   */
  readonly implicitScope: EventGroupMarkerImpl | undefined;

  /**
   * Active explicit event group markers.
   */
  readonly explicitScopes: Record<string, EventGroupMarkerImpl>;
}

abstract class EventGroupMarkerImpl implements EventGroupMarker {
  withScope<T>(fn: () => Promise<T>): Promise<T> {
    assertInWorkflowContext('EventGroupMarker.withScope(...) may only be used from a Workflow Execution');

    const active: ActiveMarkerScopes = activeMarkerScopes.getStore() ?? {
      implicitScope: undefined,
      explicitScopes: {},
    };
    const newActive = this.applyOverActiveMarkerScopes(active);

    return activeMarkerScopes.run(newActive, fn);
  }

  abstract applyOverActiveMarkerScopes(active: ActiveMarkerScopes): ActiveMarkerScopes;

  abstract toProto(converter: PayloadConverter, context?: SerializationContext): temporal.api.sdk.v1.IEventGroupMarker;
}

class ImplicitEventGroupMarkerImpl extends EventGroupMarkerImpl {
  static withInboundEventId(eventId: Long): EventGroupMarkerImpl {
    if (eventId == null || eventId.toNumber() === 0) throw new Error('Invalid event ID');
    return new ImplicitEventGroupMarkerImpl({ inboundEvent: { inboundEventId: eventId } });
  }

  static withInboundUpdateId(updateId: string): EventGroupMarkerImpl {
    return new ImplicitEventGroupMarkerImpl({ inboundUpdate: { inboundUpdateId: updateId } });
  }

  constructor(public readonly marker: IUnconvertedEventGroupMarker) {
    super();
  }

  applyOverActiveMarkerScopes(_active: ActiveMarkerScopes): ActiveMarkerScopes {
    return {
      implicitScope: this,
      explicitScopes: {},
    };
  }

  toProto(_converter: PayloadConverter, _context?: SerializationContext): temporal.api.sdk.v1.IEventGroupMarker {
    return {
      inboundEvent: this.marker.inboundEvent
        ? {
            inboundEventId: this.marker.inboundEvent?.inboundEventId,
          }
        : undefined,
      inboundUpdate: this.marker.inboundUpdate
        ? {
            inboundUpdateId: this.marker.inboundUpdate?.inboundUpdateId,
          }
        : undefined,
    };
  }
}

class ExplicitEventGroupMarkerImpl extends EventGroupMarkerImpl {
  static withLabel(label: string, id: string): EventGroupMarkerImpl {
    return new ExplicitEventGroupMarkerImpl({ label: { id, label } });
  }

  constructor(public readonly marker: IUnconvertedEventGroupMarker & { label: { id: string } }) {
    super();
  }

  applyOverActiveMarkerScopes(active: ActiveMarkerScopes): ActiveMarkerScopes {
    return deepMerge(active, {
      explicitScopes: {
        [this.marker.label.id!]: this,
      },
    });
  }

  toProto(converter: PayloadConverter, context?: SerializationContext): temporal.api.sdk.v1.IEventGroupMarker {
    return {
      label: { id: this.marker.label.id!, label: converter.toPayload(this.marker.label.label, context) },
    };
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
 *     This label will be codec-encoded using the worker's configured Payload Codecs.
 *
 *     Note that if no `id` is provided, the `id` will be derived from the `label` using a
 *     deterministic hash function. Given short and predictable labels, brute-forcing the `id`'s
 *     hashed value may be computationally feasible, thus allowing for recovery of the `label`
 *     value. Thus, it is recommended to avoid including highly sensitive informations in
 *     event-group labels, and/or to provide an explicit `id` value.
 *
 * @param id an optional opaque identifier used to determine whether two event groups are the same;
 *     i.e. events will be grouped together if and only if they are both associated with group
 *     markers that have the same `id` value, without regard to the markers' labels. Only the first
 *     label value associated with a marker `id` will be used, subsequent label values will be ignored.
 *
 *     Note that `id` will not be codec-encoded.
 *
 * @experimental Event Groups is an experimental API and may change without notice.
 */
export function createEventGroup(label: string, options?: { id?: string }): EventGroupMarker {
  const activator = assertInWorkflowContext('createEventGroup(...) may only be used from a Workflow Execution');

  // When the workflow author doesn't provide an explicit `id`, derive a deterministic, replay-stable
  // one from the label. The run id to mitigate brute-force recovery of the label from the id.
  const id = options?.id ?? sha1Hex(`${activator.info.originalExecutionRunId}${label}`);

  return ExplicitEventGroupMarkerImpl.withLabel(label, id);
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
  return ImplicitEventGroupMarkerImpl.withInboundEventId(eventId);
}

/**
 * Create an implicit group marker referencing an inbound update by its workflow-unique
 * identifier. Used by the SDK at the update-handler dispatch point; never exposed to user
 * code.
 *
 * @internal
 */
export function createInboundUpdateMarker(updateId: string): EventGroupMarker {
  return ImplicitEventGroupMarkerImpl.withInboundUpdateId(updateId);
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
 * (for explicit markers created via `createEventGroup`), the `inboundEvent` variant, or the
 * `inboundUpdate` variant (for implicit markers created by the SDK around inbound activations).
 *
 * The SDK `id` is only carried on the wire for the `label` variant. For inbound variants it is
 * derivable from `inboundEventId` / `inboundUpdateId`, so it is omitted.
 *
 * @internal
 */
export function eventGroupMarkersToProto(
  explicit: EventGroupMarker[] | undefined,
  context?: SerializationContext
): temporal.api.sdk.v1.IEventGroupMarker[] | undefined {
  const groups = mergeScopeAndDirectGroupMarkers(explicit);
  if (groups == null || groups.length === 0) return undefined;

  const { payloadConverter } = getActivator();
  return groups.map((marker) => marker.toProto(payloadConverter, context));
}

/**
 * Merge active scope group markers with directly-attached markers, deduplicating by `id`.
 */
function mergeScopeAndDirectGroupMarkers(directs: EventGroupMarker[] | undefined): EventGroupMarkerImpl[] {
  if (directs?.some((m) => !(m instanceof ExplicitEventGroupMarkerImpl))) {
    throw new Error('Directly attached Event Group Markers must be instances of ExplicitEventGroupMarkerImpl');
  }
  const directExplicits = (directs as ExplicitEventGroupMarkerImpl[]) ?? [];

  const active: ActiveMarkerScopes | undefined = activeMarkerScopes.getStore();

  const merged: Record<string, EventGroupMarkerImpl> = { ...(active?.explicitScopes ?? {}) };
  for (const marker of directExplicits) {
    merged[marker.marker.label.id!] = marker;
  }

  // The active implicit marker (from the workflow-start / signal / update dispatch scope) always
  // leads the resulting list, ahead of any explicit markers.
  return [...(active?.implicitScope ? [active.implicitScope] : []), ...Object.values(merged)];
}
