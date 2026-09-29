import test from 'ava';
import { defaultPayloadConverter, JsonPayloadConverter } from '../converter/payload-converter';
import { ValueError } from '../errors';

const unserializableValues: [string, unknown][] = [
  ['a function', () => 1],
  ['a symbol', Symbol('x')],
  [
    'an object whose toJSON returns undefined',
    {
      toJSON() {
        return undefined;
      },
    },
  ],
];

for (const [name, value] of unserializableValues) {
  test(`JsonPayloadConverter does not produce a payload for ${name}`, (t) => {
    t.is(new JsonPayloadConverter().toPayload(value), undefined);
  });

  test(`defaultPayloadConverter throws a ValueError for ${name}`, (t) => {
    t.throws(() => defaultPayloadConverter.toPayload(value), { instanceOf: ValueError, message: /Unable to convert/ });
  });
}

test('JsonPayloadConverter still encodes values that serialize to JSON null', (t) => {
  const converter = new JsonPayloadConverter();
  t.deepEqual(converter.fromPayload(converter.toPayload(null)!), null);
  t.deepEqual(converter.fromPayload(converter.toPayload(NaN)!), null);
});
