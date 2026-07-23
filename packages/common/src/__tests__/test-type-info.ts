import test from 'ava';
import type { TypeInfo } from '../type-info';
import { defaultDataConverter } from '../converter/data-converter';
import { arrayFromPayloads, defaultPayloadConverter, toPayloadsWithContext } from '../converter/payload-converter';
import { decodeArrayFromPayloads, encodeToPayloadsWithContext } from '../internal-non-workflow/codec-helpers';

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
  transferTypeConverter: {
    toTransferType: toUserAccountData,
    fromTransferType: fromUserAccountData,
  },
};

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

test('applies transfer type converters by position and preserves values without TypeInfo', (t) => {
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
