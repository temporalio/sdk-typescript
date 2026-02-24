import test from 'ava';
import { coresdk } from '@temporalio/proto';
import { makeProtoEnumConverters as makeProtoEnumConverters } from '../internal-workflow/enums-helpers';

// ASSERTION: There MUST be a corresponding `KEY: 'KEY'` in the const object of strings enum (must be present)
{
  const ParentClosePolicyMissingEntry = {
    TERMINATE: 'TERMINATE',
    // ABANDON: 'ABANDON',  // Missing entry!
    REQUEST_CANCEL: 'REQUEST_CANCEL',
  } as const;
  type ParentClosePolicyMissingEntry =
    (typeof ParentClosePolicyMissingEntry)[keyof typeof ParentClosePolicyMissingEntry];

  makeProtoEnumConverters<
    coresdk.child_workflow.ParentClosePolicy,
    typeof coresdk.child_workflow.ParentClosePolicy,
    keyof typeof coresdk.child_workflow.ParentClosePolicy,
    // @ts-expect-error 2344  Property 'ABANDON' is missing in type '{...}' but required in type '...'
    typeof ParentClosePolicyMissingEntry,
    'PARENT_CLOSE_POLICY_'
  >(
    {
      [ParentClosePolicyMissingEntry.TERMINATE]: 1,
      [ParentClosePolicyMissingEntry.REQUEST_CANCEL]: 3,
    } as const,
    'PARENT_CLOSE_POLICY_'
  );
}

// ASSERTION: There MUST be a corresponding `KEY: 'KEY'` in the const object of strings enum (must have correct value)
{
  const ParentClosePolicyIncorectEntry = {
    TERMINATE: 'TERMINATE',
    ABANDON: 'INCORRECT', // Incorrect entry!
    REQUEST_CANCEL: 'REQUEST_CANCEL',
  } as const;
  type ParentClosePolicyIncorectEntry =
    (typeof ParentClosePolicyIncorectEntry)[keyof typeof ParentClosePolicyIncorectEntry];

  makeProtoEnumConverters<
    coresdk.child_workflow.ParentClosePolicy,
    typeof coresdk.child_workflow.ParentClosePolicy,
    keyof typeof coresdk.child_workflow.ParentClosePolicy,
    // @ts-expect-error 2344 Type '"INCORRECT"' is not assignable to type '"ABANDON"'
    typeof ParentClosePolicyIncorectEntry,
    'PARENT_CLOSE_POLICY_'
  >(
    {
      [ParentClosePolicyIncorectEntry.TERMINATE]: 1,
      [ParentClosePolicyIncorectEntry.ABANDON]: 2,
      [ParentClosePolicyIncorectEntry.REQUEST_CANCEL]: 3,
    } as const,
    'PARENT_CLOSE_POLICY_'
  );
}

// ASSERTION: There MAY be a corresponding `PREFIX_KEY: 'KEY'` in the const object of strings enum (may be present)
{
  const ParentClosePolicyWithPrefixedEntries = {
    TERMINATE: 'TERMINATE',
    ABANDON: 'ABANDON',
    REQUEST_CANCEL: 'REQUEST_CANCEL',

    PARENT_CLOSE_POLICY_TERMINATE: 'TERMINATE',
    PARENT_CLOSE_POLICY_ABANDON: 'ABANDON',
    PARENT_CLOSE_POLICY_REQUEST_CANCEL: 'REQUEST_CANCEL',
  } as const;
  type ParentClosePolicyWithPrefixedEntries =
    (typeof ParentClosePolicyWithPrefixedEntries)[keyof typeof ParentClosePolicyWithPrefixedEntries];

  makeProtoEnumConverters<
    coresdk.child_workflow.ParentClosePolicy,
    typeof coresdk.child_workflow.ParentClosePolicy,
    keyof typeof coresdk.child_workflow.ParentClosePolicy,
    typeof ParentClosePolicyWithPrefixedEntries,
    'PARENT_CLOSE_POLICY_'
  >(
    {
      [ParentClosePolicyWithPrefixedEntries.TERMINATE]: 1,
      [ParentClosePolicyWithPrefixedEntries.ABANDON]: 2,
      [ParentClosePolicyWithPrefixedEntries.REQUEST_CANCEL]: 3,
      UNSPECIFIED: 0,
    } as const,
    'PARENT_CLOSE_POLICY_'
  );
}

// ASSERTION: There MAY be a corresponding `PREFIX_KEY: 'KEY'` in the const object of strings enum (may not be present)
{
  const ParentClosePolicyWithoutPrefixedEntries = {
    TERMINATE: 'TERMINATE',
    ABANDON: 'ABANDON',
    REQUEST_CANCEL: 'REQUEST_CANCEL',
  } as const;
  type ParentClosePolicyWithoutPrefixedEntries =
    (typeof ParentClosePolicyWithoutPrefixedEntries)[keyof typeof ParentClosePolicyWithoutPrefixedEntries];

  makeProtoEnumConverters<
    coresdk.child_workflow.ParentClosePolicy,
    typeof coresdk.child_workflow.ParentClosePolicy,
    keyof typeof coresdk.child_workflow.ParentClosePolicy,
    typeof ParentClosePolicyWithoutPrefixedEntries,
    'PARENT_CLOSE_POLICY_'
  >(
    {
      [ParentClosePolicyWithoutPrefixedEntries.TERMINATE]: 1,
      [ParentClosePolicyWithoutPrefixedEntries.ABANDON]: 2,
      [ParentClosePolicyWithoutPrefixedEntries.REQUEST_CANCEL]: 3,
      UNSPECIFIED: 0,
    } as const,
    'PARENT_CLOSE_POLICY_'
  );
}

// ASSERTION: There MAY be a corresponding `PREFIX_KEY: 'KEY'` in the const object of strings enum (if present, must have correct value)
{
  const ParentClosePolicyWithPrefixedEntries = {
    TERMINATE: 'TERMINATE',
    ABANDON: 'ABANDON',
    REQUEST_CANCEL: 'REQUEST_CANCEL',

    PARENT_CLOSE_POLICY_TERMINATE: 'TERMINATE',
    PARENT_CLOSE_POLICY_ABANDON: 'ABANDON',
    PARENT_CLOSE_POLICY_REQUEST_CANCEL: 'INCORRECT', // Incorrect entry!
  } as const;
  type ParentClosePolicyWithPrefixedEntries =
    (typeof ParentClosePolicyWithPrefixedEntries)[keyof typeof ParentClosePolicyWithPrefixedEntries];

  makeProtoEnumConverters<
    coresdk.child_workflow.ParentClosePolicy,
    typeof coresdk.child_workflow.ParentClosePolicy,
    keyof typeof coresdk.child_workflow.ParentClosePolicy,
    // @ts-expect-error 2344 Type '"INCORRECT"' is not assignable to type '"REQUEST_CANCEL"'
    typeof ParentClosePolicyWithPrefixedEntries,
    'PARENT_CLOSE_POLICY_'
  >(
    {
      [ParentClosePolicyWithPrefixedEntries.TERMINATE]: 1,
      [ParentClosePolicyWithPrefixedEntries.ABANDON]: 2,
      [ParentClosePolicyWithPrefixedEntries.REQUEST_CANCEL]: 3,
      UNSPECIFIED: 0,
    } as const,
    'PARENT_CLOSE_POLICY_'
  );
}

{
  const ParentClosePolicy = {
    TERMINATE: 'TERMINATE',
    ABANDON: 'ABANDON',
    REQUEST_CANCEL: 'REQUEST_CANCEL',

    PARENT_CLOSE_POLICY_UNSPECIFIED: undefined,
    PARENT_CLOSE_POLICY_TERMINATE: 'TERMINATE',
    PARENT_CLOSE_POLICY_ABANDON: 'ABANDON',
    PARENT_CLOSE_POLICY_REQUEST_CANCEL: 'REQUEST_CANCEL',
  } as const;
  type ParentClosePolicy = (typeof ParentClosePolicy)[keyof typeof ParentClosePolicy];

  // ASSERTION: There MUST be a corresponding `KEY: number` in the mapping table (must be there)
  makeProtoEnumConverters<
    coresdk.child_workflow.ParentClosePolicy,
    typeof coresdk.child_workflow.ParentClosePolicy,
    keyof typeof coresdk.child_workflow.ParentClosePolicy,
    typeof ParentClosePolicy,
    'PARENT_CLOSE_POLICY_'
  >(
    // @ts-expect-error 2345  Property '...' is missing in type '{...}' but required in type '...'
    {
      [ParentClosePolicy.TERMINATE]: 1,
      // [ParentClosePolicy.ABANDON]: 2, // Missing entry!
      [ParentClosePolicy.REQUEST_CANCEL]: 3,
      UNSPECIFIED: 0,
    } as const,
    'PARENT_CLOSE_POLICY_'
  );

  // ASSERTION: There MUST be a corresponding `KEY: number` in the mapping table (must be correct)
  makeProtoEnumConverters<
    coresdk.child_workflow.ParentClosePolicy,
    typeof coresdk.child_workflow.ParentClosePolicy,
    keyof typeof coresdk.child_workflow.ParentClosePolicy,
    typeof ParentClosePolicy,
    'PARENT_CLOSE_POLICY_'
  >(
    {
      [ParentClosePolicy.TERMINATE]: 1,
      // @ts-expect-error 2418 Type of computed property's value is '...', which is not assignable to type '...'
      [ParentClosePolicy.ABANDON]: 4, // Incorrect value!
      [ParentClosePolicy.REQUEST_CANCEL]: 3,
    } as const,
    'PARENT_CLOSE_POLICY_'
  );
}

// ASSERTION: There MAY be a corresponding `PREFIX_UNSPECIFIED: undefined` in the const object of strings enum (may be there)
{
  const ParentClosePolicyWithUnspecified = {
    TERMINATE: 'TERMINATE',
    ABANDON: 'ABANDON',
    REQUEST_CANCEL: 'REQUEST_CANCEL',
    PARENT_CLOSE_POLICY_UNSPECIFIED: undefined,
  } as const;

  makeProtoEnumConverters<
    coresdk.child_workflow.ParentClosePolicy,
    typeof coresdk.child_workflow.ParentClosePolicy,
    keyof typeof coresdk.child_workflow.ParentClosePolicy,
    typeof ParentClosePolicyWithUnspecified,
    'PARENT_CLOSE_POLICY_'
  >(
    {
      [ParentClosePolicyWithUnspecified.TERMINATE]: 1,
      [ParentClosePolicyWithUnspecified.ABANDON]: 2,
      [ParentClosePolicyWithUnspecified.REQUEST_CANCEL]: 3,
      UNSPECIFIED: 0,
    } as const,
    'PARENT_CLOSE_POLICY_'
  );
}

// ASSERTION: There MAY be a corresponding `PREFIX_UNSPECIFIED: undefined` in the const object of strings enum (may not be there)
{
  const ParentClosePolicyWithoutUnspecified = {
    TERMINATE: 'TERMINATE',
    ABANDON: 'ABANDON',
    REQUEST_CANCEL: 'REQUEST_CANCEL',
  } as const;

  makeProtoEnumConverters<
    coresdk.child_workflow.ParentClosePolicy,
    typeof coresdk.child_workflow.ParentClosePolicy,
    keyof typeof coresdk.child_workflow.ParentClosePolicy,
    typeof ParentClosePolicyWithoutUnspecified,
    'PARENT_CLOSE_POLICY_'
  >(
    {
      [ParentClosePolicyWithoutUnspecified.TERMINATE]: 1,
      [ParentClosePolicyWithoutUnspecified.ABANDON]: 2,
      [ParentClosePolicyWithoutUnspecified.REQUEST_CANCEL]: 3,
      UNSPECIFIED: 0,
    } as const,
    'PARENT_CLOSE_POLICY_'
  );
}

// ASSERTION: There MAY be a corresponding `PREFIX_UNSPECIFIED: undefined` in the const object of strings enum (if present, must have correct value)
{
  const ParentClosePolicyWithUnspecifiedIncorrectValue = {
    TERMINATE: 'TERMINATE',
    ABANDON: 'ABANDON',
    REQUEST_CANCEL: 'REQUEST_CANCEL',
    PARENT_CLOSE_POLICY_UNSPECIFIED: 'UNSPECIFIED', // Incorrect value!
  } as const;

  makeProtoEnumConverters<
    coresdk.child_workflow.ParentClosePolicy,
    typeof coresdk.child_workflow.ParentClosePolicy,
    keyof typeof coresdk.child_workflow.ParentClosePolicy,
    // @ts-expect-error 2344 Type '"UNSPECIFIED"' is not assignable to type 'undefined'
    typeof ParentClosePolicyWithUnspecifiedIncorrectValue,
    'PARENT_CLOSE_POLICY_'
  >(
    {
      [ParentClosePolicyWithUnspecifiedIncorrectValue.TERMINATE]: 1,
      [ParentClosePolicyWithUnspecifiedIncorrectValue.ABANDON]: 2,
      [ParentClosePolicyWithUnspecifiedIncorrectValue.REQUEST_CANCEL]: 3,
      UNSPECIFIED: 0,
    } as const,
    'PARENT_CLOSE_POLICY_'
  );
}

// ASSERTION: There MUST be an `UNSPECIFIED: 0` in the mapping table
{
  const ParentClosePolicyWithoutUnspecified = {
    TERMINATE: 'TERMINATE',
    ABANDON: 'ABANDON',
    REQUEST_CANCEL: 'REQUEST_CANCEL',
  } as const;

  makeProtoEnumConverters<
    coresdk.child_workflow.ParentClosePolicy,
    typeof coresdk.child_workflow.ParentClosePolicy,
    keyof typeof coresdk.child_workflow.ParentClosePolicy,
    typeof ParentClosePolicyWithoutUnspecified,
    'PARENT_CLOSE_POLICY_'
  >(
    // @ts-expect-error 2345 Property 'UNSPECIFIED' is missing in type '{...}' but required in type '...'
    {
      [ParentClosePolicyWithoutUnspecified.TERMINATE]: 1,
      [ParentClosePolicyWithoutUnspecified.ABANDON]: 2,
      [ParentClosePolicyWithoutUnspecified.REQUEST_CANCEL]: 3,
      // UNSPECIFIED: 0, // Missing UNSPECIFIED entry!
    } as const,
    'PARENT_CLOSE_POLICY_'
  );
}

// ASSERTION: The const object of strings enum MUST NOT contain any other keys than the ones mandated or optionally allowed above.
{
  const ParentClosePolicyWithExtra = {
    TERMINATE: 'TERMINATE',
    ABANDON: 'ABANDON',
    REQUEST_CANCEL: 'REQUEST_CANCEL',
    EXTRA: 'EXTRA', // Extra entry!
  } as const;
  type ParentClosePolicyWithExtra = (typeof ParentClosePolicyWithExtra)[keyof typeof ParentClosePolicyWithExtra];

  makeProtoEnumConverters<
    coresdk.child_workflow.ParentClosePolicy,
    typeof coresdk.child_workflow.ParentClosePolicy,
    keyof typeof coresdk.child_workflow.ParentClosePolicy,
    // @ts-expect-error 2344 Types of property 'EXTRA' are incompatible — Type 'string' is not assignable to type 'never'
    typeof ParentClosePolicyWithExtra,
    'PARENT_CLOSE_POLICY_'
  >(
    {
      [ParentClosePolicyWithExtra.TERMINATE]: 1,
      [ParentClosePolicyWithExtra.ABANDON]: 2,
      [ParentClosePolicyWithExtra.REQUEST_CANCEL]: 3,
      UNSPECIFIED: 0,
    } as const,
    'PARENT_CLOSE_POLICY_'
  );
}

{
  const ParentClosePolicy = {
    TERMINATE: 'TERMINATE',
    ABANDON: 'ABANDON',
    REQUEST_CANCEL: 'REQUEST_CANCEL',

    PARENT_CLOSE_POLICY_UNSPECIFIED: undefined,
    PARENT_CLOSE_POLICY_TERMINATE: 'TERMINATE',
    PARENT_CLOSE_POLICY_ABANDON: 'ABANDON',
    PARENT_CLOSE_POLICY_REQUEST_CANCEL: 'REQUEST_CANCEL',
  } as const;
  type ParentClosePolicy = (typeof ParentClosePolicy)[keyof typeof ParentClosePolicy];

  // ASSERTION: The mapping table MUST NOT contain any other keys than the ones mandated above
  makeProtoEnumConverters<
    coresdk.child_workflow.ParentClosePolicy,
    typeof coresdk.child_workflow.ParentClosePolicy,
    keyof typeof coresdk.child_workflow.ParentClosePolicy,
    typeof ParentClosePolicy,
    'PARENT_CLOSE_POLICY_'
  >(
    {
      [ParentClosePolicy.TERMINATE]: 1,
      [ParentClosePolicy.ABANDON]: 2,
      // @ts-expect-error 2353 Object literal may only specify known properties, and '...' does not exist in type
      extraEntry: 1,
      [ParentClosePolicy.REQUEST_CANCEL]: 3,
      UNSPECIFIED: 0,
    } as const,
    'PARENT_CLOSE_POLICY_'
  );

  // ASSERTION: The mapping table MUST NOT contain any other keys than the ones mandated above (duplicate entry using prefixed key)
  makeProtoEnumConverters<
    coresdk.child_workflow.ParentClosePolicy,
    typeof coresdk.child_workflow.ParentClosePolicy,
    keyof typeof coresdk.child_workflow.ParentClosePolicy,
    typeof ParentClosePolicy,
    'PARENT_CLOSE_POLICY_'
  >(
    {
      [ParentClosePolicy.TERMINATE]: 1,
      [ParentClosePolicy.ABANDON]: 2,
      //@ts-expect-error 1117 An object literal cannot have multiple properties with the same name
      [ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON]: 2, // Duplicate entry using prefixed key!
      [ParentClosePolicy.REQUEST_CANCEL]: 3,
      UNSPECIFIED: 0,
    } as const,
    'PARENT_CLOSE_POLICY_'
  );

  // ASSERTION: The mapping table MUST NOT contain any other keys than the ones mandated above (duplicate entry using prefixewd key as raw string)
  makeProtoEnumConverters<
    coresdk.child_workflow.ParentClosePolicy,
    typeof coresdk.child_workflow.ParentClosePolicy,
    keyof typeof coresdk.child_workflow.ParentClosePolicy,
    typeof ParentClosePolicy,
    'PARENT_CLOSE_POLICY_'
  >(
    {
      [ParentClosePolicy.TERMINATE]: 1,
      [ParentClosePolicy.ABANDON]: 2,
      // @ts-expect-error 2353 Object literal may only specify known properties, and '...' does not exist in type
      PARENT_CLOSE_POLICY_ABANDON: 2, // Duplicate entry using prefixed key!
      [ParentClosePolicy.REQUEST_CANCEL]: 3,
      UNSPECIFIED: 0,
    } as const,
    'PARENT_CLOSE_POLICY_'
  );

  // ASSERTION: If a prefix is provided, then all values in the proto enum MUST start with that prefix
  makeProtoEnumConverters<
    coresdk.child_workflow.ParentClosePolicy,
    typeof coresdk.child_workflow.ParentClosePolicy,
    // @ts-expect-error 2344 Type '...' does not satisfy the constraint '...'.
    keyof typeof coresdk.child_workflow.ParentClosePolicy,
    typeof ParentClosePolicy,
    'INVALID_PREFIX_' // Incorrect prefix!
  >(
    {
      [ParentClosePolicy.TERMINATE]: 1,
      [ParentClosePolicy.ABANDON]: 2,
      [ParentClosePolicy.REQUEST_CANCEL]: 3,
    } as const,
    'INVALID_PREFIX_'
  );
}

// Functionnal tests
{
  const ParentClosePolicy = {
    TERMINATE: 'TERMINATE',
    ABANDON: 'ABANDON',
    REQUEST_CANCEL: 'REQUEST_CANCEL',

    PARENT_CLOSE_POLICY_UNSPECIFIED: undefined,
    PARENT_CLOSE_POLICY_TERMINATE: 'TERMINATE',
    PARENT_CLOSE_POLICY_ABANDON: 'ABANDON',
    PARENT_CLOSE_POLICY_REQUEST_CANCEL: 'REQUEST_CANCEL',
  } as const;
  type ParentClosePolicy = (typeof ParentClosePolicy)[keyof typeof ParentClosePolicy];

  const [encodeParentClosePolicy, decodeParentClosePolicy] = //
    makeProtoEnumConverters<
      coresdk.child_workflow.ParentClosePolicy,
      typeof coresdk.child_workflow.ParentClosePolicy,
      keyof typeof coresdk.child_workflow.ParentClosePolicy,
      typeof ParentClosePolicy,
      'PARENT_CLOSE_POLICY_'
    >(
      {
        [ParentClosePolicy.TERMINATE]: 1,
        [ParentClosePolicy.ABANDON]: 2,
        [ParentClosePolicy.REQUEST_CANCEL]: 3,

        UNSPECIFIED: 0,
      } as const,
      'PARENT_CLOSE_POLICY_'
    );

  test('Protobuf Enum to Const Object of Strings conversion works', (t) => {
    t.is(encodeParentClosePolicy(undefined), undefined);
    t.is(encodeParentClosePolicy(ParentClosePolicy.PARENT_CLOSE_POLICY_UNSPECIFIED), undefined);

    t.is(
      encodeParentClosePolicy(ParentClosePolicy.TERMINATE),
      coresdk.child_workflow.ParentClosePolicy.PARENT_CLOSE_POLICY_TERMINATE
    );
    t.is(
      encodeParentClosePolicy(ParentClosePolicy.ABANDON),
      coresdk.child_workflow.ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON
    );
    t.is(
      encodeParentClosePolicy(ParentClosePolicy.REQUEST_CANCEL),
      coresdk.child_workflow.ParentClosePolicy.PARENT_CLOSE_POLICY_REQUEST_CANCEL
    );

    t.is(
      encodeParentClosePolicy(ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON),
      coresdk.child_workflow.ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON
    );
    t.is(
      encodeParentClosePolicy(ParentClosePolicy.PARENT_CLOSE_POLICY_TERMINATE),
      coresdk.child_workflow.ParentClosePolicy.PARENT_CLOSE_POLICY_TERMINATE
    );
    t.is(
      encodeParentClosePolicy(ParentClosePolicy.PARENT_CLOSE_POLICY_REQUEST_CANCEL),
      coresdk.child_workflow.ParentClosePolicy.PARENT_CLOSE_POLICY_REQUEST_CANCEL
    );
  });

  test('Const Object of Strings to Protobuf Enum conversion works', (t) => {
    t.is(
      decodeParentClosePolicy(coresdk.child_workflow.ParentClosePolicy.PARENT_CLOSE_POLICY_TERMINATE),
      ParentClosePolicy.TERMINATE
    );
    t.is(
      decodeParentClosePolicy(coresdk.child_workflow.ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON),
      ParentClosePolicy.ABANDON
    );
    t.is(
      decodeParentClosePolicy(coresdk.child_workflow.ParentClosePolicy.PARENT_CLOSE_POLICY_REQUEST_CANCEL),
      ParentClosePolicy.REQUEST_CANCEL
    );
  });
}
