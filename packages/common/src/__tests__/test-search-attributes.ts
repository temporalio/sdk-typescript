import test from 'ava';
import { decodeTypedSearchAttributes, encodeUnifiedSearchAttributes } from '../converter/payload-search-attributes';
import { encodingKeys, METADATA_ENCODING_KEY } from '../converter/types';
import { encode } from '../encoding';
import type { Payload } from '../interfaces';
import { defineSearchAttributeKey, SearchAttributeType, TypedSearchAttributes } from '../search-attributes';

test('KeywordList typed search attribute null set value is rejected', (t) => {
  const key = defineSearchAttributeKey('my-keyword-list', SearchAttributeType.KEYWORD_LIST);

  t.throws(() => new TypedSearchAttributes([{ key, value: null } as any]));
});

test('KeywordList typed search attribute null element is rejected', (t) => {
  const key = defineSearchAttributeKey('my-keyword-list', SearchAttributeType.KEYWORD_LIST);

  t.throws(() => new TypedSearchAttributes([{ key, value: ['keyword', null] } as any]));
  t.throws(() => encodeUnifiedSearchAttributes(undefined, [{ key, value: ['keyword', null] } as any]));
});

test('KeywordList typed search attribute unset serializes without type metadata', (t) => {
  const key = defineSearchAttributeKey('my-keyword-list', SearchAttributeType.KEYWORD_LIST);

  const payload = encodeUnifiedSearchAttributes(undefined, [{ key, value: null }])[key.name];

  t.deepEqual(payload.metadata?.[METADATA_ENCODING_KEY], encodingKeys.METADATA_ENCODING_JSON);
  t.deepEqual(payload.data, encode('null'));
  t.false('type' in (payload.metadata ?? {}));
});

test('KeywordList typed search attribute null payload decodes as absent', (t) => {
  const key = defineSearchAttributeKey('my-keyword-list', SearchAttributeType.KEYWORD_LIST);
  const nullWithoutType: Payload = {
    metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_JSON },
    data: encode('null'),
  };
  const legacyNullWithType: Payload = {
    metadata: {
      [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_JSON,
      type: encode('KeywordList'),
    },
    data: encode('null'),
  };

  for (const payload of [nullWithoutType, legacyNullWithType]) {
    const attrs = decodeTypedSearchAttributes({ [key.name]: payload });
    t.is(attrs.get(key), undefined);
    t.deepEqual(attrs.getAll(), []);
  }
});
