import test from 'ava';
import * as otel from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { defaultDataConverter, defaultPayloadConverter } from '@temporalio/common';
import { decodeHeaders, encodeHeaders } from '@temporalio/common/internal/internal-non-workflow';
import { extractContextFromHeaders, headersWithContext, rawHeadersWithContext, TRACE_HEADER } from '../instrumentation';

test('tracing keeps standard serialization and follows automatic header codecs', async (t) => {
  otel.propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  try {
    const span = { traceId: '12345678901234567890123456789012', spanId: '1234567890123456', traceFlags: 1 };
    const active = otel.trace.setSpanContext(otel.ROOT_CONTEXT, span);
    otel.context.setGlobalContextManager({
      active: () => active,
      with: (_context, fn, thisArg, ...args) => fn.call(thisArg, ...args),
      bind: (_context, target) => target,
      enable() {
        return this;
      },
      disable() {
        return this;
      },
    });
    const headers = headersWithContext({});
    const raw = rawHeadersWithContext(undefined);
    t.deepEqual(defaultPayloadConverter.fromPayload(headers[TRACE_HEADER]!), raw[TRACE_HEADER]);
    for (const enabled of [false, true]) {
      const converter = {
        ...defaultDataConverter,
        encodeHeaders: enabled,
        payloadCodecs: [
          {
            encode: async () => [defaultPayloadConverter.toPayload('encoded trace')],
            decode: async () => [headers[TRACE_HEADER]!],
          },
        ],
      };
      const encoded = await encodeHeaders(converter, headers);
      t.deepEqual(
        defaultPayloadConverter.fromPayload(encoded[TRACE_HEADER]!),
        enabled ? 'encoded trace' : raw[TRACE_HEADER]
      );
      const decoded = await decodeHeaders(converter, encoded);
      t.deepEqual(otel.trace.getSpanContext(extractContextFromHeaders(decoded)!), { ...span, isRemote: true });
    }
  } finally {
    otel.propagation.disable();
    otel.context.disable();
  }
});
