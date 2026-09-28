import type { AsyncLocalStorage as ALS } from 'node:async_hooks';
import type Long from 'long';
import type { temporal } from '@temporalio/proto';
import { convertOptionalToPayload, defaultPayloadConverter } from '@temporalio/common/lib/converter/payload-converter';
import { AsyncLocalStorage } from './cancellation-scope';
import { assertInWorkflowContext } from './global-attributes';

/**
 * A discrete token used to associate workflow commands (and the corresponding history events)
 * with a logical "group" for UI/observability purposes. Multiple Event Groups may be attached to
 * a single command, and a single Event Group may be attached to multiple commands.
 *
 * Created using {@link createEventGroup}.
 *
 * @experimental Event Groups is an experimental API and may change without notice.
 */
export interface EventGroup {
  /**
   * Run `fn` in a scope in which this Event Group is implicitly attached to every command
   * produced by the workflow code that executes within. Event Group scopes nest: when called from
   * within another Event Group's `withScope`, all outer groups remain attached as well.
   *
   * Only callable from a Workflow Execution.
   *
   * @experimental Event Groups is an experimental API and may change without notice.
   */
  withScope<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Options for attaching Event Groups to a command that has no existing options object.
 *
 * @experimental Event Groups is an experimental API and may change without notice.
 */
export interface EventGroupsOptions {
  /**
   * Event Groups to attach to this command, in addition to those active in the current scope.
   * See {@link EventGroup} and {@link createEventGroup}.
   */
  eventGroups?: EventGroup[];
}

/** Active event group markers in the current execution scope. */
const activeMarkerScopes: ALS<ActiveMarkerScopes> = new AsyncLocalStorage();

interface ActiveMarkerScopes {
  /**
   * The active implicit event group marker.
   *
   * There's at most one active implicit event group marker scope at any point in time,
   * corresponding to the inbound workflow event that triggered execution of the current
   * handler (i.e. either WorkflowExecutionSignaled or WorkflowExecutionUpdated).
   *
   * `undefined` in the Workflow's main function, as well as while executing Queries and
   * Update Validation handlers.
   */
  readonly implicitScope: EventGroupImpl | undefined;

  /**
   * Active explicit event group markers.
   */
  readonly explicitScopes: Record<string, EventGroupImpl>;
}

abstract class EventGroupImpl implements EventGroup {
  withScope<T>(fn: () => Promise<T>): Promise<T> {
    assertInWorkflowContext('EventGroup.withScope(...) may only be used from a Workflow Execution');

    const active: ActiveMarkerScopes = activeMarkerScopes.getStore() ?? {
      implicitScope: undefined,
      explicitScopes: {},
    };
    const newActive = this.applyOverActiveMarkerScopes(active);

    return activeMarkerScopes.run(newActive, fn);
  }

  abstract applyOverActiveMarkerScopes(active: ActiveMarkerScopes): ActiveMarkerScopes;

  abstract toProto(): temporal.api.sdk.v1.IEventGroupMarker;
}

abstract class ImplicitEventGroupImpl extends EventGroupImpl {
  applyOverActiveMarkerScopes(_active: ActiveMarkerScopes): ActiveMarkerScopes {
    return {
      implicitScope: this,
      explicitScopes: {},
    };
  }
}

class InboundEventEventGroupImpl extends ImplicitEventGroupImpl {
  constructor(private readonly inboundEventId: Long) {
    super();
  }

  toProto(): temporal.api.sdk.v1.IEventGroupMarker {
    return { inboundEvent: { inboundEventId: this.inboundEventId } };
  }
}

class InboundUpdateEventGroupImpl extends ImplicitEventGroupImpl {
  constructor(private readonly inboundUpdateId: string) {
    super();
  }

  toProto(): temporal.api.sdk.v1.IEventGroupMarker {
    return { inboundUpdate: { inboundUpdateId: this.inboundUpdateId } };
  }
}

/**
 * This stub provides a safe fallback for the case where we'd try to create an Implicit
 * Event Group Marker for an inbound event, but receive an invalid event ID.
 *
 * To be clear, this should never happen and would indicate a bug in the SDK itself.
 * Still, we wouldn't want that situation to result in failing the WFT, as Event Groups
 * is a non-critical feature.
 *
 * Instead, we return a stub Implicit Event Group Marker that honors the interface,
 * including the `withScope()` method with proper bookkeeping logic. This way, callers
 * can proceed through their normal code path without having to know about this anomaly.
 */
class StubImplicitEventGroupImpl extends EventGroupImpl {
  constructor() {
    super();
  }

  applyOverActiveMarkerScopes(_active: ActiveMarkerScopes): ActiveMarkerScopes {
    return {
      implicitScope: undefined,
      explicitScopes: {},
    };
  }

  toProto(): temporal.api.sdk.v1.IEventGroupMarker {
    // This method will never get called, since the stub will not set itself as
    // the active implicit scope, and therefore won't get collected by
    // mergeScopeAndDirectEventGroupMarkers() for serialization.
    return {};
  }
}

class ExplicitEventGroupImpl extends EventGroupImpl {
  constructor(
    readonly id: string,
    private readonly label?: string
  ) {
    super();
  }

  applyOverActiveMarkerScopes(active: ActiveMarkerScopes): ActiveMarkerScopes {
    return {
      implicitScope: active.implicitScope,
      explicitScopes: { ...active.explicitScopes, [this.id]: this },
    };
  }

  toProto(): temporal.api.sdk.v1.IEventGroupMarker {
    // Deliberately the SDK's default converter rather than the workflow's own: the UI and CLI
    // rely on the label being a `json/plain` string, which a user-provided converter could break.
    return {
      label: {
        id: this.id,
        label: convertOptionalToPayload(defaultPayloadConverter, this.label),
      },
    };
  }
}

/**
 * Create an Event Group that can be attached to commands scheduled by this Workflow.
 *
 * Attach the returned group via command `eventGroups` options, or via {@link EventGroup.withScope}.
 *
 * @param id non-empty group identity. Commands with the same `id` belong to the same group.
 *           The user-provided ID is stored as plain text in the workflow history and should
 *           therefore not contain sensitive information.
 * @param options.label optional non-empty display text for the UI / CLI. If provided, it is
 *           persisted to history as a codec-encoded Payload.
 *
 * @experimental Event Groups is an experimental API and may change without notice.
 */
export function createEventGroup(id: string, options?: { label?: string }): EventGroup {
  assertInWorkflowContext('createEventGroup(...) may only be used from a Workflow Execution');
  if (id === '') throw new TypeError('Event group id cannot be empty');

  const label = options?.label;
  if (label === '') throw new TypeError('Event group label cannot be empty');

  return new ExplicitEventGroupImpl(id, label);
}

/**
 * Create an implicit group marker referencing a specific history event by ID. Used by the
 * SDK at the signal handler dispatch point; never exposed to user code.
 *
 * @internal
 */
export function createInboundEventMarker(eventId: Long | null | undefined): EventGroup {
  if (eventId == null || eventId.toNumber() <= 0) {
    // This is totally unexpected and would indicate a bug in the SDK itself. But
    // Event Groups is non-critical, so return a stub instead of failing the WFT.
    return new StubImplicitEventGroupImpl();
  }
  return new InboundEventEventGroupImpl(eventId);
}

/**
 * Create an implicit group marker referencing an inbound update by its workflow-unique
 * identifier. Used by the SDK at the update-handler dispatch point; never exposed to user
 * code.
 *
 * @internal
 */
export function createInboundUpdateMarker(updateId: string): EventGroup {
  return new InboundUpdateEventGroupImpl(updateId);
}

/**
 * Merge the explicitly-attached markers with those active in the current execution scope and
 * serialize the result into the proto form attached to a workflow command.
 *
 * This function reads the active-scope markers from AsyncLocalStorage, and may therefore only be
 * called from within a Workflow Execution.
 *
 * Returns `undefined` if no marker ends up attached, so the caller can omit the `eventGroupMarkers`
 * field from the outgoing command altogether (matching the convention used for `userMetadata`).
 *
 * Each marker is encoded as one of the `EventGroupMarker.variant` cases: the `label` variant
 * (for explicit markers created via `createEventGroup`), the `inboundEvent` variant, or the
 * `inboundUpdate` variant (for implicit markers created by the SDK around inbound signal and
 * update handlers).
 *
 * The SDK `id` is only carried on the wire for the `label` variant. For inbound variants it is
 * derivable from `inboundEventId` / `inboundUpdateId`, so it is omitted.
 *
 * @internal
 */
export function eventGroupMarkersToProto(
  explicit: EventGroup[] | undefined
): temporal.api.sdk.v1.IEventGroupMarker[] | undefined {
  const markers = mergeScopeAndDirectEventGroupMarkers(explicit);
  if (markers == null || markers.length === 0) return undefined;

  return markers.map((marker) => marker.toProto());
}

/**
 * Merge active scope event group markers with directly-attached markers, deduplicating by `id`.
 */
function mergeScopeAndDirectEventGroupMarkers(directs: EventGroup[] | undefined): EventGroupImpl[] {
  if (directs?.some((group) => !(group instanceof ExplicitEventGroupImpl))) {
    throw new TypeError('Directly attached Event Groups must be created with createEventGroup()');
  }
  const directExplicits = (directs as ExplicitEventGroupImpl[]) ?? [];

  const active: ActiveMarkerScopes | undefined = activeMarkerScopes.getStore();

  const merged: Record<string, EventGroupImpl> = { ...(active?.explicitScopes ?? {}) };
  for (const marker of directExplicits) {
    merged[marker.id] = marker;
  }

  return [...(active?.implicitScope ? [active.implicitScope] : []), ...Object.values(merged)];
}
