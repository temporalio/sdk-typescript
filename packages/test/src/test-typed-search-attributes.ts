import { randomUUID } from 'crypto';
import { ExecutionContext } from 'ava';
import { ScheduleOptionsAction, WorkflowExecutionDescription } from '@temporalio/client';
import {
  TypedSearchAttributes,
  SearchAttributes,
  SearchAttributePair,
  SearchAttributeType,
  SearchAttributeUpdatePair,
} from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import {
  condition,
  defineQuery,
  defineSignal,
  setHandler,
  upsertSearchAttributes,
  WorkflowInfo,
  workflowInfo,
} from '@temporalio/workflow';
import { encodeSearchAttributeIndexedValueType } from '@temporalio/common/lib/search-attributes';
import { waitUntil } from './helpers';
import { Context, helpers, makeTestFunction } from './helpers-integration';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowEnvironmentOpts: {
    server: {
      namespace: 'test-typed-search-attributes',
    },
  },
});

const date = new Date();
const secondDate = new Date(date.getTime() + 1000);

const untypedAttrsInput: SearchAttributes = {
  untyped_single_string: ['one'],
  untyped_single_int: [1],
  untyped_single_double: [1.23],
  untyped_single_bool: [true],
  untyped_single_date: [date],
  untyped_multi_string: ['one', 'two'],
};

// The corresponding typed search attributes from untypedSearchAttributes.
const typedFromUntypedInput: SearchAttributePair[] = [
  { key: { name: 'untyped_single_string', type: SearchAttributeType.TEXT }, value: 'one' },
  { key: { name: 'untyped_single_int', type: SearchAttributeType.INT }, value: 1 },
  { key: { name: 'untyped_single_double', type: SearchAttributeType.DOUBLE }, value: 1.23 },
  { key: { name: 'untyped_single_bool', type: SearchAttributeType.BOOL }, value: true },
  { key: { name: 'untyped_single_date', type: SearchAttributeType.DATETIME }, value: date },
  { key: { name: 'untyped_multi_string', type: SearchAttributeType.KEYWORD_LIST }, value: ['one', 'two'] },
];

const typedAttrsListInput: SearchAttributePair[] = [
  { key: { name: 'typed_text', type: SearchAttributeType.TEXT }, value: 'typed_text' },
  { key: { name: 'typed_keyword', type: SearchAttributeType.KEYWORD }, value: 'typed_keyword' },
  { key: { name: 'typed_int', type: SearchAttributeType.INT }, value: 123 },
  { key: { name: 'typed_double', type: SearchAttributeType.DOUBLE }, value: 123.45 },
  { key: { name: 'typed_bool', type: SearchAttributeType.BOOL }, value: true },
  { key: { name: 'typed_datetime', type: SearchAttributeType.DATETIME }, value: date },
  { key: { name: 'typed_keyword_list', type: SearchAttributeType.KEYWORD_LIST }, value: ['typed', 'keywords'] },
];

const typedAttrsObjInput = new TypedSearchAttributes(typedAttrsListInput);

// The corresponding untyped search attributes from typedSearchAttributesList.
const untypedFromTypedInput: SearchAttributes = {
  typed_text: ['typed_text'],
  typed_keyword: ['typed_keyword'],
  typed_int: [123],
  typed_double: [123.45],
  typed_bool: [true],
  typed_datetime: [date],
  typed_keyword_list: ['typed', 'keywords'],
};

const erroneousTypedKeys = {
  erroneous_typed_int: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_INT,
};

const dummyWorkflow = async () => undefined;

// Note: this is needed, the test fails due to
// test.serial.before not being defined when running workflows.
if (test?.serial?.before) {
  // Register all search attribute keys.
  test.serial.before(async (t) => {
    // Transform untyped keys into 'untypedKey: IndexValueType' pairs.
    const untypedKeys = Object.entries(untypedAttrsInput).reduce(
      (acc, [key, value]) => {
        const typedKey = TypedSearchAttributes.getKeyFromUntyped(key, value);
        const encodedKey = encodeSearchAttributeIndexedValueType(typedKey?.type);
        if (encodedKey) {
          acc[key] = encodedKey;
        }
        return acc;
      },
      {} as { [key: string]: temporal.api.enums.v1.IndexedValueType }
    );

    const typedKeys = typedAttrsListInput.reduce(
      (acc, pair) => {
        const encodedKey = encodeSearchAttributeIndexedValueType(pair.key.type);
        if (encodedKey) {
          acc[pair.key.name] = encodedKey;
        }
        return acc;
      },
      {} as { [key: string]: temporal.api.enums.v1.IndexedValueType }
    );

    await t.context.env.connection.operatorService.addSearchAttributes({
      namespace: t.context.env.namespace,
      searchAttributes: {
        ...untypedKeys,
        ...typedKeys,
        ...erroneousTypedKeys,
      },
    });

    await waitUntil(async () => {
      const resp = await t.context.env.connection.operatorService.listSearchAttributes({
        namespace: t.context.env.namespace,
      });
      return (
        Object.keys(untypedKeys).every((key) => key in resp.customAttributes) &&
        Object.keys(typedKeys).every((key) => key in resp.customAttributes)
      );
    }, 300);
  });
}

test('does not allow non-integer values for integer search attributes', async (t) => {
  try {
    const { taskQueue } = helpers(t);
    const client = t.context.env.client;
    const action: ScheduleOptionsAction = {
      type: 'startWorkflow',
      workflowType: dummyWorkflow,
      taskQueue,
    };
    const erroneousKeyName = Object.keys(erroneousTypedKeys)[0];
    await client.schedule.create({
      scheduleId: randomUUID(),
      spec: {
        calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
      },
      action,
      typedSearchAttributes: [
        // Use a double value for an integer search attribute.
        // This is legal at compile-time, but should error at runtime when converting to payload.
        { key: { name: erroneousKeyName, type: SearchAttributeType.INT }, value: 123.4 },
      ],
    });
  } catch (err) {
    if (err instanceof Error) {
      t.is(err.message, 'Invalid search attribute value 123.4 for given type INT');
    } else {
      t.fail('Unexpected error type');
    }
  }
});

interface TestInputSearchAttributes {
  input: {
    searchAttributes?: SearchAttributes;
    typedSearchAttributes?: TypedSearchAttributes | SearchAttributePair[];
  };
  expected: {
    searchAttributes?: SearchAttributes;
    typedSearchAttributes?: TypedSearchAttributes;
  };
}

// inputTestCases contains permutations of search attribute inputs
const inputTestCases: TestInputSearchAttributes[] = [
  // Input only untyped search attributes
  {
    input: {
      searchAttributes: untypedAttrsInput,
    },
    expected: {
      searchAttributes: untypedAttrsInput,
      typedSearchAttributes: new TypedSearchAttributes(typedFromUntypedInput),
    },
  },
  // Input only typed search attributes as a list
  {
    input: {
      typedSearchAttributes: typedAttrsListInput,
    },
    expected: {
      searchAttributes: untypedFromTypedInput,
      typedSearchAttributes: typedAttrsObjInput,
    },
  },
  // Input only typed search attributes as an object
  {
    input: {
      typedSearchAttributes: typedAttrsObjInput,
    },
    expected: {
      searchAttributes: untypedFromTypedInput,
      typedSearchAttributes: typedAttrsObjInput,
    },
  },
  // Input both untyped and typed search attributes
  {
    input: {
      searchAttributes: {
        ...untypedAttrsInput,
        // Expect to be overwritten by the corresponding typed search attribute. Overwritten value to be "typed_text".
        typed_text: ['different_value_from_untyped'],
      },
      typedSearchAttributes: typedAttrsListInput,
    },
    expected: {
      searchAttributes: {
        ...untypedFromTypedInput,
        ...untypedAttrsInput,
      },
      typedSearchAttributes: typedAttrsObjInput.updateCopy(typedFromUntypedInput),
    },
  },
];

test('creating schedules with various input search attributes', async (t) => {
  await Promise.all(
    inputTestCases.map(async ({ input, expected }) => {
      const { taskQueue } = helpers(t);
      const client = t.context.env.client;
      const action: ScheduleOptionsAction = {
        type: 'startWorkflow',
        workflowType: dummyWorkflow,
        taskQueue,
      };
      const handle = await client.schedule.create({
        scheduleId: randomUUID(),
        spec: {
          calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
        },
        action,
        ...input,
      });
      const desc = await handle.describe();
      t.deepEqual(desc.searchAttributes, expected.searchAttributes);
      t.deepEqual(desc.typedSearchAttributes, expected.typedSearchAttributes);
    })
  );
});

export const getWorkflowInfo = defineQuery<WorkflowInfo>('getWorkflowInfo');
export const mutateSearchAttributes =
  defineSignal<[SearchAttributes | SearchAttributeUpdatePair[]]>('mutateSearchAttributes');
export const complete = defineSignal('complete');

export async function changeSearchAttributes(): Promise<void> {
  let isComplete = false;
  setHandler(getWorkflowInfo, () => {
    return workflowInfo();
  });
  setHandler(complete, () => {
    isComplete = true;
  });
  setHandler(mutateSearchAttributes, (attrs) => {
    upsertSearchAttributes(attrs);
  });
  await condition(() => isComplete);
}

test('upsert works with various search attribute mutations', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({ namespace: t.context.env.namespace });
  await worker.runUntil(async () => {
    // Start workflow with some initial search attributes.
    const handle = await startWorkflow(changeSearchAttributes, {
      typedSearchAttributes: typedAttrsListInput,
    });
    let res = await handle.query(getWorkflowInfo);
    let desc = await handle.describe();
    assertWorkflowInfoSearchAttributes(t, res, untypedFromTypedInput, typedAttrsListInput);
    assertWorkflowDescSearchAttributes(t, desc, untypedFromTypedInput, typedAttrsListInput);

    // Update search attributes with untyped input.
    const untypedUpdateAttrs: SearchAttributes = {
      typed_text: ['new_value'],
      typed_keyword: ['new_keyword'],
      typed_int: [2],
      typed_double: [2.34],
      typed_datetime: [secondDate],
      typed_keyword_list: ['three', 'four', 'five'],
      // Delete key - empty value.
      typed_bool: [],
    };

    // Update search attributes with untyped input.
    await handle.signal(mutateSearchAttributes, untypedUpdateAttrs);
    res = await handle.query(getWorkflowInfo);
    desc = await handle.describe();

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { typed_bool, ...untypedUpdateExpected } = untypedUpdateAttrs;

    // Note: There is a discrepancy between typed search attributes in workflow info and workflow
    // exec description after upserts with untyped search attributes.
    //
    // The upsert in this test is done through a signal, which serializes the upsert input.
    // The serialized input converts dates to their ISO string representation. When we read untyped
    // seralized search attributes in upsert, we try to infer their key type based on the value.
    // By default, untyped string values are identified as TEXT type. As a result, serialized date strings
    // become TEXT type and attributes that may have been KEYWORD type are also inferred as TEXT type.
    //
    // When we read the search attributes from the workflow info, we expect to see these type conversions
    // in the typed search attributes.
    //
    // This does not happen with workflow exec description. It's unclear to me why this happens, given that
    // the same upsert logic applies. The only difference being that we decode search attributes from server
    // for the workflow exec description.

    assertWorkflowInfoSearchAttributes(t, res, untypedUpdateExpected, [
      { key: { name: 'typed_text', type: SearchAttributeType.TEXT }, value: 'new_value' },
      // Note that 'typed_keyword' is updated as type TEXT, as its inferred from the untyped input.
      { key: { name: 'typed_keyword', type: SearchAttributeType.TEXT }, value: 'new_keyword' },
      { key: { name: 'typed_int', type: SearchAttributeType.INT }, value: 2 },
      { key: { name: 'typed_double', type: SearchAttributeType.DOUBLE }, value: 2.34 },
      { key: { name: 'typed_keyword_list', type: SearchAttributeType.KEYWORD_LIST }, value: ['three', 'four', 'five'] },
      // Note: 'typed_datetime' becomes a 'TEXT' string when serialized by the signal.
      { key: { name: 'typed_datetime', type: SearchAttributeType.TEXT }, value: secondDate.toISOString() },
    ]);

    assertWorkflowDescSearchAttributes(t, desc, untypedUpdateExpected, [
      { key: { name: 'typed_text', type: SearchAttributeType.TEXT }, value: 'new_value' },
      { key: { name: 'typed_keyword', type: SearchAttributeType.KEYWORD }, value: 'new_keyword' },
      { key: { name: 'typed_int', type: SearchAttributeType.INT }, value: 2 },
      { key: { name: 'typed_double', type: SearchAttributeType.DOUBLE }, value: 2.34 },
      { key: { name: 'typed_keyword_list', type: SearchAttributeType.KEYWORD_LIST }, value: ['three', 'four', 'five'] },
      { key: { name: 'typed_datetime', type: SearchAttributeType.DATETIME }, value: secondDate },
    ]);

    // Update search attributes with typed input.
    const typedUpdateAttrs: SearchAttributeUpdatePair[] = [
      // Delete key.
      { key: { name: 'typed_text', type: SearchAttributeType.TEXT }, value: null },
      { key: { name: 'typed_int', type: SearchAttributeType.INT }, value: 3 },
      { key: { name: 'typed_double', type: SearchAttributeType.DOUBLE }, value: 3.45 },
      { key: { name: 'typed_keyword_list', type: SearchAttributeType.KEYWORD_LIST }, value: ['six', 'seven'] },
      // Add key.
      { key: { name: 'typed_bool', type: SearchAttributeType.BOOL }, value: false },
    ];

    // Update search attributes with typed input.
    await handle.signal(mutateSearchAttributes, typedUpdateAttrs);
    res = await handle.query(getWorkflowInfo);
    desc = await handle.describe();

    // Note that we expect the empty array in the untyped search attributes.
    const expectedUntyped = {
      typed_int: [3],
      typed_double: [3.45],
      typed_keyword_list: ['six', 'seven'],
      typed_bool: [false],
      typed_keyword: ['new_keyword'],
      typed_datetime: [secondDate],
    };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { typed_keyword, typed_datetime, ...newDescExpected } = expectedUntyped;
    const expectedTyped = [
      { key: { name: 'typed_int', type: SearchAttributeType.INT }, value: 3 },
      { key: { name: 'typed_double', type: SearchAttributeType.DOUBLE }, value: 3.45 },
      { key: { name: 'typed_keyword_list', type: SearchAttributeType.KEYWORD_LIST }, value: ['six', 'seven'] },
      { key: { name: 'typed_bool', type: SearchAttributeType.BOOL }, value: false },
      { key: { name: 'typed_keyword', type: SearchAttributeType.TEXT }, value: 'new_keyword' },
      { key: { name: 'typed_datetime', type: SearchAttributeType.TEXT }, value: secondDate.toISOString() },
    ];

    const expectedDescTyped = [
      { key: { name: 'typed_int', type: SearchAttributeType.INT }, value: 3 },
      { key: { name: 'typed_double', type: SearchAttributeType.DOUBLE }, value: 3.45 },
      { key: { name: 'typed_keyword_list', type: SearchAttributeType.KEYWORD_LIST }, value: ['six', 'seven'] },
      { key: { name: 'typed_bool', type: SearchAttributeType.BOOL }, value: false },
      { key: { name: 'typed_keyword', type: SearchAttributeType.KEYWORD }, value: 'new_keyword' },
      { key: { name: 'typed_datetime', type: SearchAttributeType.DATETIME }, value: secondDate },
    ];

    assertWorkflowInfoSearchAttributes(t, res, expectedUntyped, expectedTyped);
    assertWorkflowDescSearchAttributes(t, desc, newDescExpected, expectedDescTyped);

    await handle.signal(complete);
  });
});

function assertWorkflowInfoSearchAttributes(
  t: ExecutionContext<Context>,
  res: WorkflowInfo,
  searchAttributes: SearchAttributes,
  searchAttrPairs: SearchAttributePair[]
) {
  // Check initial search attributes are present.
  // Response from query serializes datetime attributes to strings so we serialize our expected responses.
  t.deepEqual(res.searchAttributes, normalizeSearchAttrs(searchAttributes));
  assertMatchingSearchAttributePairs(t, res.typedSearchAttributes, searchAttrPairs);
}

function assertWorkflowDescSearchAttributes(
  t: ExecutionContext<Context>,
  desc: WorkflowExecutionDescription,
  searchAttributes: SearchAttributes,
  searchAttrPairs: SearchAttributePair[]
) {
  // Check that all search attributes are present in the workflow description's search attributes.
  t.like(desc.searchAttributes, searchAttributes);
  const descOmittingBuildIds = desc.typedSearchAttributes
    .updateCopy([{ key: { name: 'BuildIds', type: SearchAttributeType.BOOL }, value: null }])
    .getAll();
  assertMatchingSearchAttributePairs(t, descOmittingBuildIds, searchAttrPairs);
}

function normalizeSearchAttrs(attrs: SearchAttributes): SearchAttributes {
  const res: SearchAttributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (Array.isArray(value) && value.length === 1 && value[0] instanceof Date) {
      res[key] = [value[0].toISOString()];
      continue;
    }
    res[key] = value;
  }
  return res;
}

function normalizeSearchAttrPairs(attrs: SearchAttributePair[]): SearchAttributePair[] {
  const res: SearchAttributePair[] = [];
  for (const { key, value } of attrs) {
    if (value instanceof Date) {
      res.push({ key, value: value.toISOString() } as SearchAttributePair);
      continue;
    }
    res.push({ key, value } as SearchAttributePair);
  }
  return res;
}

function assertMatchingSearchAttributePairs(
  t: ExecutionContext<Context>,
  actual: SearchAttributePair[],
  expected: SearchAttributePair[]
) {
  t.deepEqual(
    normalizeSearchAttrPairs(actual).sort((a, b) => a.key.name.localeCompare(b.key.name)),
    normalizeSearchAttrPairs(expected).sort((a, b) => a.key.name.localeCompare(b.key.name))
  );
}
