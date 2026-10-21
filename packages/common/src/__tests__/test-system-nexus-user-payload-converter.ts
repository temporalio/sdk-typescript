import test from 'ava';
import { DefaultFailureConverter } from '../converter/failure-converter';
import { DefaultPayloadConverter } from '../converter/payload-converter';
import type { SerializationContext } from '../converter/serialization-context';
import {
  currentSystemNexusPayloadConversion,
  withSystemNexusPayloadConversion,
} from '../nexus/system/user-payload-converter';
import {
  currentSystemNexusPayloadConversion as currentFromInternalEntryPoint,
  withSystemNexusPayloadConversion as withFromInternalEntryPoint,
} from '../nexus/system/support';

test('System Nexus conversion state is shared through the internal entry point', (t) => {
  t.is(currentFromInternalEntryPoint, currentSystemNexusPayloadConversion);
  t.is(withFromInternalEntryPoint, withSystemNexusPayloadConversion);
});

test('System Nexus conversion scopes restore the outer state, including after errors', (t) => {
  const converter = {
    payloadConverter: new DefaultPayloadConverter(),
    failureConverter: new DefaultFailureConverter(),
  };
  const innerConverter = {
    payloadConverter: new DefaultPayloadConverter(),
    failureConverter: new DefaultFailureConverter({ encodeCommonAttributes: true }),
  };
  const context: SerializationContext = { type: 'workflow', namespace: 'outer', workflowId: 'outer' };
  const innerContext: SerializationContext = {
    type: 'nexus',
    endpoint: 'inner',
    service: 'Notifications',
    operation: 'onComplete',
  };
  t.throws(currentSystemNexusPayloadConversion, {
    message: 'System Nexus user payload converter context is not active',
  });
  const result = withSystemNexusPayloadConversion(converter, context, () => {
    const outer = currentSystemNexusPayloadConversion();
    t.is(outer.converter, converter.payloadConverter);
    t.is(outer.failureConverter, converter.failureConverter);
    t.is(outer.context, context);
    t.is(
      withSystemNexusPayloadConversion(innerConverter, innerContext, () => {
        const inner = currentSystemNexusPayloadConversion();
        t.is(inner.converter, innerConverter.payloadConverter);
        t.is(inner.failureConverter, innerConverter.failureConverter);
        t.is(inner.context, innerContext);
        return 'inner result';
      }),
      'inner result'
    );
    t.is(currentSystemNexusPayloadConversion(), outer);
    t.throws(() =>
      withSystemNexusPayloadConversion(innerConverter, innerContext, () => {
        throw new Error('conversion failed');
      })
    );
    t.is(currentSystemNexusPayloadConversion(), outer);
    return 'outer result';
  });
  t.is(result, 'outer result');
  t.throws(currentSystemNexusPayloadConversion);
});
