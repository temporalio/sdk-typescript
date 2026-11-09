import * as nexus from 'nexus-rpc';
import type { Payload, PayloadCodec, SerializationContext } from '@temporalio/common';
import { contextToTraceString } from './payload-converters/serialization-context-converter';

/**
 * Older servers wrap handler errors in an extra HandlerError; newer servers do not.
 * Given a HandlerError, skip past one optional HandlerError wrapper and return the
 * inner cause (e.g. ApplicationFailure, CancelledFailure, or other Error).
 */
export function unwrapHandlerErrorCause(handler: nexus.HandlerError): unknown {
  return handler.cause instanceof nexus.HandlerError
    ? handler.cause.cause // old server: skip extra wrapper
    : handler.cause; // new server: cause is direct
}

/**
 * Given a HandlerError, return the innermost HandlerError in the chain
 * (skipping one optional server-added wrapper).
 */
export function innermostHandlerError(handler: nexus.HandlerError): nexus.HandlerError {
  return handler.cause instanceof nexus.HandlerError ? handler.cause : handler;
}

/** Payload metadata key {@link nexusContextMarkerCodec} stamps its marker under. */
export const MARKER_KEY = 'nexus-context-marker';
/** {@link nexusContextMarkerCodec} key for payloads serialized without a context. */
export const NO_CONTEXT = 'no-context';

/**
 * Stamps a per-context marker into payload metadata on encode, and requires the same marker on
 * decode. A payload decoded under a different Nexus context, or none, throws rather than silently
 * round-tripping, so a test passes only if each payload is decoded with the exact context it was
 * encoded with. Markers are keyed by context, or by {@link NO_CONTEXT} for payloads serialized
 * without one.
 */
export function nexusContextMarkerCodec(markers: Record<string, string>): PayloadCodec {
  const markerFor = (context?: SerializationContext): string | undefined =>
    markers[context == null ? NO_CONTEXT : contextToTraceString(context)];
  return {
    async encode(payloads: Payload[], context?: SerializationContext): Promise<Payload[]> {
      const marker = markerFor(context);
      if (marker == null) return payloads;
      return payloads.map((payload) => ({
        ...payload,
        metadata: { ...payload.metadata, [MARKER_KEY]: new TextEncoder().encode(marker) },
      }));
    },
    async decode(payloads: Payload[], context?: SerializationContext): Promise<Payload[]> {
      return payloads.map((payload) => {
        const stamped = payload.metadata?.[MARKER_KEY];
        if (stamped == null) return payload;
        const found = new TextDecoder().decode(stamped);
        const expected = markerFor(context);
        if (found !== expected) {
          throw new Error(`payload marked '${found}' was decoded as '${expected ?? 'no context'}'`);
        }
        const { [MARKER_KEY]: _marker, ...metadata } = payload.metadata ?? {};
        return { ...payload, metadata };
      });
    },
  };
}
