export const TEMPORAL_RESERVED_PREFIX = '__temporal_';
export const STACK_TRACE_QUERY_NAME = '__stack_trace';
export const ENHANCED_STACK_TRACE_QUERY_NAME = '__enhanced_stack_trace';

/**
 * Valid entity types that can be checked for reserved name violations
 */
export type ReservedNameEntityType = 'query' | 'signal' | 'update' | 'activity' | 'task queue' | 'sink' | 'workflow';

/**
 * Wire identifiers used by first-party SDK contrib packages. Each entry pairs
 * a name with the entity type it's allowed to register as; that pair bypasses
 * the {@link TEMPORAL_RESERVED_PREFIX} check at registration time. Registering
 * the same name as a different entity type is still rejected.
 */
const INTERNAL_HANDLER_NAME_ALLOWLIST: ReadonlyMap<string, ReservedNameEntityType> = new Map([
  // @temporalio/workflow-streams
  ['__temporal_workflow_stream_publish', 'signal'],
  ['__temporal_workflow_stream_poll', 'update'],
  ['__temporal_workflow_stream_offset', 'query'],
]);

/**
 * Validates if the provided name contains any reserved prefixes or matches any reserved names.
 * Throws a TypeError if validation fails, with a specific message indicating whether the issue
 * is with a reserved prefix or an exact match to a reserved name.
 *
 * @param type The entity type being checked
 * @param name The name to check against reserved prefixes/names
 */
export function throwIfReservedName(type: ReservedNameEntityType, name: string): void {
  if (name.startsWith(TEMPORAL_RESERVED_PREFIX) && INTERNAL_HANDLER_NAME_ALLOWLIST.get(name) !== type) {
    throw new TypeError(`Cannot use ${type} name: '${name}', with reserved prefix: '${TEMPORAL_RESERVED_PREFIX}'`);
  }

  if (name === STACK_TRACE_QUERY_NAME || name === ENHANCED_STACK_TRACE_QUERY_NAME) {
    throw new TypeError(`Cannot use ${type} name: '${name}', which is a reserved name`);
  }
}
