import test from 'ava';
import { Field, Type } from 'protobufjs';
import { defaultDataConverter } from '../converter/data-converter';
import {
  CompositePayloadConverter,
  defaultPayloadConverter,
  JsonPayloadConverter,
  type PayloadConverter,
} from '../converter/payload-converter';
import { ProtobufBinaryPayloadConverter } from '../converter/protobuf-payload-converters';
import type { PayloadCodec } from '../converter/payload-codec';
import type { SerializationContext } from '../converter/serialization-context';
import { PayloadConverterError, ValueError } from '../errors';
import type { Payload } from '../interfaces';
import {
  decodeArrayFromPayloads,
  decodeFromPayloadsAtIndex,
  encodeToPayload,
  encodeToPayloadsWithContext,
} from '../internal-non-workflow/codec-helpers';
import type { ConverterHint, TypeInfo } from '../type-info';

class UserAccount {
  constructor(
    readonly id: string,
    readonly balanceInCents: bigint
  ) {}
}

interface UserAccountData {
  id: string;
  balanceInCents: string;
}

function toUserAccountData(account: UserAccount): UserAccountData {
  return {
    id: account.id,
    balanceInCents: account.balanceInCents.toString(),
  };
}

function fromUserAccountData(value: UserAccountData): UserAccount {
  return new UserAccount(value.id, BigInt(value.balanceInCents));
}

const userAccountTypeInfo: TypeInfo<UserAccount, UserAccountData> = {
  transferTypeConverter: {
    toTransferType: toUserAccountData,
    fromTransferType: fromUserAccountData,
  },
};

interface ProtobufJsConverterHint<T = unknown> extends ConverterHint<T> {
  converter: 'protobufjs';
  messageType: Type;
}

function isProtobufJsConverterHint(hint: ConverterHint): hint is ProtobufJsConverterHint {
  return hint.converter === 'protobufjs' && 'messageType' in hint && hint.messageType instanceof Type;
}

class HintedProtobufBinaryPayloadConverter extends ProtobufBinaryPayloadConverter {
  validateConverterHint(hint: ConverterHint): hint is ProtobufJsConverterHint {
    return isProtobufJsConverterHint(hint);
  }

  override toPayload(value: unknown, _context?: SerializationContext, hint?: ConverterHint): Payload | undefined {
    if (hint === undefined) {
      return super.toPayload(value);
    }
    if (!this.validateConverterHint(hint)) {
      return undefined;
    }
    return this.constructPayload({
      messageTypeName: hint.messageType.fullName,
      message: hint.messageType.encode(Object.assign(hint.messageType.create(), value)).finish(),
    });
  }

  override fromPayload<T>(payload: Payload, _context?: SerializationContext, hint?: ConverterHint): T {
    if (hint === undefined) {
      return super.fromPayload(payload);
    }
    if (!this.validateConverterHint(hint)) {
      throw new PayloadConverterError('Invalid protobufjs converter hint');
    }
    if (payload.data == null) {
      throw new ValueError('Got payload with no data');
    }
    return hint.messageType.decode(payload.data) as T;
  }
}

function checkPayloadConverterHintTypes(
  converter: PayloadConverter,
  payload: Payload,
  valueHint: ProtobufJsConverterHint<{ value: string }>,
  countHint: ProtobufJsConverterHint<{ count: number }>
): void {
  converter.toPayload({ value: '123' }, undefined, valueHint);
  converter.toPayload({ count: 123 }, undefined, countHint);
  converter.fromPayload<{ value: string }>(payload, undefined, valueHint);
  converter.fromPayload<{ count: number }>(payload, undefined, countHint);

  // @ts-expect-error 2345 Converter hint value type must match the converted value type.
  converter.fromPayload<{ value: string }>(payload, undefined, countHint);
}
void checkPayloadConverterHintTypes;

test('converts an application class to a transfer type around JSON payload conversion', async (t) => {
  const account = new UserAccount('account-123', 123n);
  const payloads = await encodeToPayloadsWithContext(defaultDataConverter, undefined, [account], [userAccountTypeInfo]);

  t.deepEqual(payloads, [defaultPayloadConverter.toPayload(toUserAccountData(account))]);

  const [result] = await decodeArrayFromPayloads(defaultDataConverter, payloads, undefined, [userAccountTypeInfo]);
  if (!(result instanceof UserAccount)) {
    t.fail('Expected a UserAccount');
    return;
  }
  t.is(result.id, account.id);
  t.is(result.balanceInCents, account.balanceInCents);
});

test('single-payload encoding applies transfer conversion before payload codecs', async (t) => {
  const stages: string[] = [];
  const account = new UserAccount('account-123', 123n);
  const typeInfo: TypeInfo<UserAccount, UserAccountData> = {
    transferTypeConverter: {
      toTransferType(value) {
        stages.push('transfer');
        return toUserAccountData(value);
      },
      fromTransferType: fromUserAccountData,
    },
  };
  const payloadConverter: PayloadConverter = {
    toPayload(value, context, hint) {
      stages.push('payload-converter');
      return defaultPayloadConverter.toPayload(value, context, hint);
    },
    fromPayload(payload, context, hint) {
      return defaultPayloadConverter.fromPayload(payload, context, hint);
    },
  };
  const payloadCodec: PayloadCodec = {
    async encode(payloads) {
      stages.push('payload-codec');
      return payloads;
    },
    async decode(payloads) {
      return payloads;
    },
  };
  const converter = { ...defaultDataConverter, payloadConverter, payloadCodecs: [payloadCodec] };

  const payload = await encodeToPayload(converter, account, undefined, typeInfo);

  t.deepEqual(payload, defaultPayloadConverter.toPayload(toUserAccountData(account)));
  t.deepEqual(stages, ['transfer', 'payload-converter', 'payload-codec']);
});

test('single-payload encoding preserves best-effort conversion without TypeInfo', async (t) => {
  const value = { value: '123' };

  const payload = await encodeToPayload(defaultDataConverter, value);

  t.deepEqual(payload, defaultPayloadConverter.toPayload(value));
});

test('uses a converter hint to serialize and deserialize a protobuf message', async (t) => {
  const messageType = new Type('HintedValue').add(new Field('value', 1, 'string'));
  const hint = {
    converter: 'protobufjs',
    messageType,
  } satisfies ProtobufJsConverterHint<{ value: string }>;
  const typeInfo: TypeInfo<{ value: string }, { value: string }> = { payloadConverterHint: hint };
  const converter = {
    ...defaultDataConverter,
    payloadConverter: new CompositePayloadConverter(
      new JsonPayloadConverter(),
      new HintedProtobufBinaryPayloadConverter()
    ),
  };

  const payload = await encodeToPayload(converter, { value: '123' }, undefined, typeInfo);
  const result = await decodeFromPayloadsAtIndex(converter, 0, [payload], undefined, typeInfo);

  t.is(result.value, '123');
});
