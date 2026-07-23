import test from 'ava';
import type { TypeInfo } from '../type-info';
import { arrayFromPayloads, defaultPayloadConverter, toPayloadsWithContext } from '../converter/payload-converter';

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
