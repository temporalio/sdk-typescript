import test from 'ava';
import { Field, Type } from 'protobufjs';
import { PayloadConverterError, ValueError } from '../errors';
import type { Payload } from '../interfaces';
import type { ConverterHint, TypeInfo } from '../type-info';
import {
  arrayFromPayloads,
  CompositePayloadConverter,
  defaultPayloadConverter,
  toPayloadsWithContext,
} from '../converter/payload-converter';
import { ProtobufBinaryPayloadConverter } from '../converter/protobuf-payload-converters';
import type { SerializationContext } from '../converter/serialization-context';

interface ProtobufJsConverterHint<T = unknown> extends ConverterHint<T> {
  converter: 'protobufjs';
  messageType: Type;
}

function isProtobufJsConverterHint(hint: ConverterHint): hint is ProtobufJsConverterHint {
  return hint.converter === 'protobufjs' && (hint as Partial<ProtobufJsConverterHint>).messageType instanceof Type;
}

class HintProtobufBinaryPayloadConverter extends ProtobufBinaryPayloadConverter {
  validateConverterHint(hint: ConverterHint): hint is ProtobufJsConverterHint {
    return isProtobufJsConverterHint(hint);
  }

  override toPayload<T>(value: T, _context?: SerializationContext, hint?: ConverterHint): Payload | undefined {
    if (hint === undefined) {
      return super.toPayload(value);
    }
    if (!this.validateConverterHint(hint)) {
      return undefined;
    }
    return this.constructPayload({
      messageTypeName: hint.messageType.fullName,
      message: hint.messageType.encode(value as Parameters<Type['encode']>[0]).finish(),
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

const messageType = new Type('HintedValue').add(new Field('value', 1, 'string'));
const protobufHint = {
  converter: 'protobufjs',
  messageType,
} satisfies ProtobufJsConverterHint<{ value: string }>;

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

function fromUserAccountData(value: unknown): UserAccount {
  const data = value as UserAccountData;
  return new UserAccount(data.id, BigInt(data.balanceInCents));
}

const userAccountTypeInfo: TypeInfo<UserAccount> = {
  mapper: {
    toIntermediate: toUserAccountData,
    fromIntermediate: fromUserAccountData,
  },
};

test('maps an application class around JSON payload conversion', (t) => {
  const account = new UserAccount('account-123', 123n);
  const payloads = toPayloadsWithContext(defaultPayloadConverter, undefined, [account], [userAccountTypeInfo]);
  t.deepEqual(payloads, [defaultPayloadConverter.toPayload(toUserAccountData(account))]);

  const [result] = arrayFromPayloads(defaultPayloadConverter, payloads, undefined, [userAccountTypeInfo]);

  if (!(result instanceof UserAccount)) {
    t.fail('Expected a UserAccount');
    return;
  }
  t.is(result.id, account.id);
  t.is(result.balanceInCents, account.balanceInCents);
});

test('applies mappers by position and preserves values without TypeInfo', (t) => {
  const account = new UserAccount('account-123', 123n);
  const payloads = toPayloadsWithContext(
    defaultPayloadConverter,
    undefined,
    [account, 'untyped'],
    [userAccountTypeInfo]
  );

  t.deepEqual(arrayFromPayloads(defaultPayloadConverter, payloads, undefined, [userAccountTypeInfo]), [
    account,
    'untyped',
  ]);
});

test('uses a converter hint to serialize and deserialize a protobuf message', (t) => {
  const converter = new CompositePayloadConverter(new HintProtobufBinaryPayloadConverter());
  const typeInfo: TypeInfo<{ value: string }> = { hint: protobufHint };
  const value = { value: '123' };
  const payloads = toPayloadsWithContext(converter, undefined, [value], [typeInfo]);
  const [result] = arrayFromPayloads(converter, payloads, undefined, [typeInfo]);

  t.deepEqual(result, messageType.create(value));
});

test('preserves best-effort JSON conversion without a hint', (t) => {
  const payload = defaultPayloadConverter.toPayload({ value: 123 });

  t.deepEqual(defaultPayloadConverter.fromPayload(payload), { value: 123 });
});

test('rejects unsupported converter hints', (t) => {
  const converter = new CompositePayloadConverter(new HintProtobufBinaryPayloadConverter());
  const payload = converter.toPayload({ value: '123' }, undefined, protobufHint);

  t.throws(() => converter.toPayload({ value: 123 }, undefined, { converter: 'unsupported' }), {
    message: "No payload converter supports converter hint 'unsupported'",
  });
  t.throws(() => converter.fromPayload(payload, undefined, { converter: 'unsupported' }), {
    message: /does not support converter hint 'unsupported'/,
  });
});

test('propagates converter errors', (t) => {
  const converterError = new Error('converter failed');
  const converter = new CompositePayloadConverter(
    new (class extends HintProtobufBinaryPayloadConverter {
      override toPayload(): Payload | undefined {
        throw converterError;
      }
    })()
  );

  t.is(
    t.throws(() => converter.toPayload({ value: '123' }, undefined, protobufHint)),
    converterError
  );
});
