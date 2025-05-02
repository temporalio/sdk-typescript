export const TEMPORAL_RESERVED_PREFIX = '__temporal_';
export const STACK_TRACE_RESERVED_PREFIX = '__stack_trace';
export const ENHANCED_STACK_TRACE_RESERVED_PREFIX = '__enhanced_stack_trace';

export const reservedPrefixes = [
  TEMPORAL_RESERVED_PREFIX,
  STACK_TRACE_RESERVED_PREFIX,
  ENHANCED_STACK_TRACE_RESERVED_PREFIX,
];

export function throwIfReservedName(type: string, name: string): void {
  const prefix = isReservedName(name);
  if (prefix) {
    throw Error(`Cannot register ${type} name: '${name}', with reserved prefix: '${prefix}'`);
  }
}

export function isReservedName(name: string): string | undefined {
  for (const prefix of reservedPrefixes) {
    if (name.startsWith(prefix)) {
      return prefix;
    }
  }
}
