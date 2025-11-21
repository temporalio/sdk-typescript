import { randomUUID } from 'crypto';
import { ExecutionContext } from 'ava';
import { ScheduleOptionsAction, WorkflowExecutionDescription } from '@temporalio/client';
import {
  TypedSearchAttributes,
  SearchAttributes,
  SearchAttributePair,
  SearchAttributeType,
  SearchAttributeUpdatePair,
  defineSearchAttributeKey,
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
      searchAttributes: [],
    },
  },
});

const date = new Date();
const secondDate = new Date(date.getTime() + 1000);

// eslint-disable-next-line deprecation/deprecation
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
  { key: defineSearchAttributeKey('untyped_single_string', SearchAttributeType.TEXT), value: 'one' },
  { key: defineSearchAttributeKey('untyped_single_int', SearchAttributeType.INT), value: 1 },
  { key: defineSearchAttributeKey('untyped_single_double', SearchAttributeType.DOUBLE), value: 1.23 },
  { key: defineSearchAttributeKey('untyped_single_bool', SearchAttributeType.BOOL), value: true },
  { key: defineSearchAttributeKey('untyped_single_date', SearchAttributeType.DATETIME), value: date },
  { key: defineSearchAttributeKey('untyped_multi_string', SearchAttributeType.KEYWORD_LIST), value: ['one', 'two'] },
];

const typedAttrsListInput: SearchAttributePair[] = [
  { key: defineSearchAttributeKey('typed_text', SearchAttributeType.TEXT), value: 'typed_text' },
  { key: defineSearchAttributeKey('typed_keyword', SearchAttributeType.KEYWORD), value: 'typed_keyword' },
  { key: defineSearchAttributeKey('typed_int', SearchAttributeType.INT), value: 123 },
  { key: defineSearchAttributeKey('typed_double', SearchAttributeType.DOUBLE), value: 123.45 },
  { key: defineSearchAttributeKey('typed_bool', SearchAttributeType.BOOL), value: true },
  { key: defineSearchAttributeKey('typed_datetime', SearchAttributeType.DATETIME), value: date },
  {
    key: defineSearchAttributeKey('typed_keyword_list', SearchAttributeType.KEYWORD_LIST),
    value: ['typed', 'keywords'],
  },
];

const typedAttrsObjInput = new TypedSearchAttributes(typedAttrsListInput);

// The corresponding untyped search attributes from typedSearchAttributesList.
// eslint-disable-next-line deprecation/deprecation
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
    }, 5000);
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
        { key: defineSearchAttributeKey(erroneousKeyName, SearchAttributeType.INT), value: 123.4 },
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
  name: string;
  input: {
    searchAttributes?: SearchAttributes; // eslint-disable-line deprecation/deprecation
    typedSearchAttributes?: TypedSearchAttributes | SearchAttributePair[];
  };
  expected: {
    searchAttributes?: SearchAttributes; // eslint-disable-line deprecation/deprecation
    typedSearchAttributes?: TypedSearchAttributes;
  };
}

// inputTestCases contains permutations of search attribute inputs
const inputTestCases: TestInputSearchAttributes[] = [
  // Input only untyped search attributes
  {
    name: 'only-untyped-search-attributes',
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
    name: 'only-typed-search-attributes-list',
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
    name: 'only-typed-search-attributes-obj',
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
    name: 'both-untyped-and-typed-sa',
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
    inputTestCases.map(async ({ input, expected, name }) => {
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
      t.deepEqual(desc.searchAttributes, expected.searchAttributes, name); // eslint-disable-line deprecation/deprecation
      t.deepEqual(desc.typedSearchAttributes, expected.typedSearchAttributes, name);
    })
  );
});

export const getWorkflowInfo = defineQuery<WorkflowInfo>('getWorkflowInfo');
export const mutateSearchAttributes =
  defineSignal<[SearchAttributes | SearchAttributeUpdatePair[]]>('mutateSearchAttributes'); // eslint-disable-line deprecation/deprecation
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
    // eslint-disable-next-line deprecation/deprecation
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

    assertWorkflowInfoSearchAttributes(t, res, untypedUpdateExpected, [
      { key: defineSearchAttributeKey('typed_text', SearchAttributeType.TEXT), value: 'new_value' },
      { key: defineSearchAttributeKey('typed_keyword', SearchAttributeType.KEYWORD), value: 'new_keyword' },
      { key: defineSearchAttributeKey('typed_int', SearchAttributeType.INT), value: 2 },
      { key: defineSearchAttributeKey('typed_double', SearchAttributeType.DOUBLE), value: 2.34 },
      {
        key: defineSearchAttributeKey('typed_keyword_list', SearchAttributeType.KEYWORD_LIST),
        value: ['three', 'four', 'five'],
      },
      { key: defineSearchAttributeKey('typed_datetime', SearchAttributeType.DATETIME), value: secondDate },
    ]);

    assertWorkflowDescSearchAttributes(t, desc, untypedUpdateExpected, [
      { key: defineSearchAttributeKey('typed_text', SearchAttributeType.TEXT), value: 'new_value' },
      { key: defineSearchAttributeKey('typed_keyword', SearchAttributeType.KEYWORD), value: 'new_keyword' },
      { key: defineSearchAttributeKey('typed_int', SearchAttributeType.INT), value: 2 },
      { key: defineSearchAttributeKey('typed_double', SearchAttributeType.DOUBLE), value: 2.34 },
      {
        key: defineSearchAttributeKey('typed_keyword_list', SearchAttributeType.KEYWORD_LIST),
        value: ['three', 'four', 'five'],
      },
      { key: defineSearchAttributeKey('typed_datetime', SearchAttributeType.DATETIME), value: secondDate },
    ]);

    // Update search attributes with typed input.
    const typedUpdateAttrs: SearchAttributeUpdatePair[] = [
      // Delete key.
      { key: defineSearchAttributeKey('typed_text', SearchAttributeType.TEXT), value: null },
      { key: defineSearchAttributeKey('typed_int', SearchAttributeType.INT), value: 3 },
      { key: defineSearchAttributeKey('typed_double', SearchAttributeType.DOUBLE), value: 3.45 },
      {
        key: defineSearchAttributeKey('typed_keyword_list', SearchAttributeType.KEYWORD_LIST),
        value: ['six', 'seven'],
      },
      // Add key.
      { key: defineSearchAttributeKey('typed_bool', SearchAttributeType.BOOL), value: false },
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
      { key: defineSearchAttributeKey('typed_int', SearchAttributeType.INT), value: 3 },
      { key: defineSearchAttributeKey('typed_double', SearchAttributeType.DOUBLE), value: 3.45 },
      {
        key: defineSearchAttributeKey('typed_keyword_list', SearchAttributeType.KEYWORD_LIST),
        value: ['six', 'seven'],
      },
      { key: defineSearchAttributeKey('typed_bool', SearchAttributeType.BOOL), value: false },
      { key: defineSearchAttributeKey('typed_keyword', SearchAttributeType.KEYWORD), value: 'new_keyword' },
      { key: defineSearchAttributeKey('typed_datetime', SearchAttributeType.DATETIME), value: secondDate },
    ];

    const expectedDescTyped = [
      { key: defineSearchAttributeKey('typed_int', SearchAttributeType.INT), value: 3 },
      { key: defineSearchAttributeKey('typed_double', SearchAttributeType.DOUBLE), value: 3.45 },
      {
        key: defineSearchAttributeKey('typed_keyword_list', SearchAttributeType.KEYWORD_LIST),
        value: ['six', 'seven'],
      },
      { key: defineSearchAttributeKey('typed_bool', SearchAttributeType.BOOL), value: false },
      { key: defineSearchAttributeKey('typed_keyword', SearchAttributeType.KEYWORD), value: 'new_keyword' },
      { key: defineSearchAttributeKey('typed_datetime', SearchAttributeType.DATETIME), value: secondDate },
    ];

    assertWorkflowInfoSearchAttributes(t, res, expectedUntyped, expectedTyped);
    assertWorkflowDescSearchAttributes(t, desc, newDescExpected, expectedDescTyped);

    await handle.signal(complete);
  });
});

function assertWorkflowInfoSearchAttributes(
  t: ExecutionContext<Context>,
  res: WorkflowInfo,
  searchAttributes: SearchAttributes, // eslint-disable-line deprecation/deprecation
  searchAttrPairs: SearchAttributePair[]
) {
  // Check initial search attributes are present.
  // Response from query serializes datetime attributes to strings so we serialize our expected responses.
  t.deepEqual(res.searchAttributes, normalizeSearchAttrs(searchAttributes)); // eslint-disable-line deprecation/deprecation
  // This casting is necessary because res.typedSearchAttributes has actually been serialized by its toJSON method
  // (returning an array of SearchAttributePair), but is not reflected in its type definition.
  assertMatchingSearchAttributePairs(t, res.typedSearchAttributes as unknown as SearchAttributePair[], searchAttrPairs);
}

function assertWorkflowDescSearchAttributes(
  t: ExecutionContext<Context>,
  desc: WorkflowExecutionDescription,
  searchAttributes: SearchAttributes, // eslint-disable-line deprecation/deprecation
  searchAttrPairs: SearchAttributePair[]
) {
  // Check that all search attributes are present in the workflow description's search attributes.
  t.like(desc.searchAttributes, searchAttributes); // eslint-disable-line deprecation/deprecation
  const descOmittingBuildIds = desc.typedSearchAttributes
    .updateCopy([{ key: defineSearchAttributeKey('BuildIds', SearchAttributeType.KEYWORD_LIST), value: null }])
    .getAll();
  assertMatchingSearchAttributePairs(t, descOmittingBuildIds, searchAttrPairs);
}

// eslint-disable-next-line deprecation/deprecation
function normalizeSearchAttrs(attrs: SearchAttributes): SearchAttributes {
  const res: SearchAttributes = {}; // eslint-disable-line deprecation/deprecation
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
