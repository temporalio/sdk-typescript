import { randomUUID } from 'crypto';
import { ExecutionContext } from 'ava';
import { ScheduleOptionsAction, WorkflowExecutionDescription } from '@temporalio/client';
import {
  TypedSearchAttributes,
  SearchAttributes,
  TypedSearchAttributePair,
  SearchAttributeType,
  searchAttributePair,
  encodeSearchAttributeIndexedValueType,
  TypedSearchAttributeUpdatePair,
  searchAttributeUpdatePair,
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
const typedFromUntypedInput: TypedSearchAttributePair[] = [
  searchAttributePair('untyped_single_string', SearchAttributeType.TEXT, 'one'),
  searchAttributePair('untyped_single_int', SearchAttributeType.INT, 1),
  searchAttributePair('untyped_single_double', SearchAttributeType.DOUBLE, 1.23),
  searchAttributePair('untyped_single_bool', SearchAttributeType.BOOL, true),
  searchAttributePair('untyped_single_date', SearchAttributeType.DATETIME, date),
  searchAttributePair('untyped_multi_string', SearchAttributeType.KEYWORD_LIST, ['one', 'two']),
];

const typedAttrsListInput: TypedSearchAttributePair[] = [
  searchAttributePair('typed_text', SearchAttributeType.TEXT, 'typed_text'),
  searchAttributePair('typed_keyword', SearchAttributeType.KEYWORD, 'typed_keyword'),
  searchAttributePair('typed_int', SearchAttributeType.INT, 123),
  searchAttributePair('typed_double', SearchAttributeType.DOUBLE, 123.45),
  searchAttributePair('typed_bool', SearchAttributeType.BOOL, true),
  searchAttributePair('typed_datetime', SearchAttributeType.DATETIME, date),
  searchAttributePair('typed_keyword_list', SearchAttributeType.KEYWORD_LIST, ['typed', 'keywords']),
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

// TODO(thomas): not sure why this is needed, but the test fails due to
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
      (acc, [key]) => {
        const encodedKey = encodeSearchAttributeIndexedValueType(key.type);
        if (encodedKey) {
          acc[key.name] = encodedKey;
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
    const key = Object.keys(erroneousTypedKeys)[0];
    await client.schedule.create({
      scheduleId: randomUUID(),
      spec: {
        calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
      },
      action,
      typedSearchAttributes: [
        // Use a double value for an integer search attribute.
        // This is legal at compile-time, but should error at runtime when converting to payload.
        searchAttributePair(key, SearchAttributeType.INT, 123.4),
      ],
    });
  } catch (err) {
    if (err instanceof Error) {
      t.is(err.message, 'Invalid typed search attribute: INT,123.4');
    } else {
      t.fail('Unexpected error type');
    }
  }
});

interface TestInputSearchAttributes {
  input: {
    searchAttributes?: SearchAttributes;
    typedSearchAttributes?: TypedSearchAttributes | TypedSearchAttributePair[];
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
      typedSearchAttributes: typedAttrsObjInput.updateSearchAttributes(typedFromUntypedInput),
    },
  },
];

test('creating schedules with various input search attributes', async (t) => {
  await Promise.all(
    inputTestCases.map(async ({ input, expected: output }) => {
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
      t.deepEqual(desc.searchAttributes, output.searchAttributes);
      t.deepEqual(desc.typedSearchAttributes, output.typedSearchAttributes);
    })
  );
});

// Update search attributes with untyped input.
const untypedUpdateAttrs: SearchAttributes = {
  typed_text: ['new_value'],
  typed_keyword: ['new_keyword'],
  typed_int: [2],
  typed_double: [2.34],
  typed_datetime: [secondDate],
  typed_keyword_list: ['three', 'four', 'five'],
  // Delete key.
  typed_bool: [],
};

// Update search attributes with typed input.
const typedUpdateAttrs: TypedSearchAttributeUpdatePair[] = [
  searchAttributePair('typed_text', SearchAttributeType.TEXT, 'even_newer_value'),
  searchAttributePair('typed_int', SearchAttributeType.INT, 3),
  searchAttributePair('typed_double', SearchAttributeType.DOUBLE, 3.45),
  searchAttributePair('typed_keyword_list', SearchAttributeType.KEYWORD_LIST, ['six', 'seven']),
  // Add key.
  searchAttributePair('typed_bool', SearchAttributeType.BOOL, false),
  // Delete key.
  searchAttributeUpdatePair('typed_keyword', SearchAttributeType.KEYWORD, null),
  // Delete key.
  searchAttributeUpdatePair('typed_datetime', SearchAttributeType.DATETIME, null),
];

interface WorkflowInfoWithMeta {
  info: WorkflowInfo;
  isTypedSearchAttributesInstance: boolean;
}

export const getWorkflowInfoWithMeta = defineQuery<WorkflowInfoWithMeta>('getWorkflowInfo');
export const mutateSearchAttributes =
  defineSignal<[SearchAttributes | TypedSearchAttributeUpdatePair[]]>('mutateSearchAttributes');
export const complete = defineSignal('complete');

export async function changeSearchAttributes(): Promise<void> {
  let isComplete = false;
  setHandler(getWorkflowInfoWithMeta, () => {
    const info = workflowInfo();
    return {
      info,
      isTypedSearchAttributesInstance: info.typedSearchAttributes instanceof TypedSearchAttributes,
    };
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
    let res = await handle.query(getWorkflowInfoWithMeta);
    let desc = await handle.describe();

    assertWorkflowInfoSearchAttributes(t, res, untypedFromTypedInput, typedAttrsObjInput);
    assertWorkflowDescSearchAttributes(t, desc, untypedFromTypedInput, typedAttrsObjInput);

    // Update search attributes with untyped input.
    await handle.signal(mutateSearchAttributes, untypedUpdateAttrs);
    res = await handle.query(getWorkflowInfoWithMeta);
    desc = await handle.describe();

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { typed_bool, ...descExpected } = untypedUpdateAttrs;

    assertWorkflowInfoSearchAttributes(
      t,
      res,
      untypedUpdateAttrs,
      new TypedSearchAttributes([
        searchAttributePair('typed_text', SearchAttributeType.TEXT, 'new_value'),
        // Note that 'typed_keyword' is updated as type TEXT, as its inferred from the untyped input.
        searchAttributePair('typed_keyword', SearchAttributeType.TEXT, 'new_keyword'),
        searchAttributePair('typed_int', SearchAttributeType.INT, 2),
        searchAttributePair('typed_double', SearchAttributeType.DOUBLE, 2.34),
        searchAttributePair('typed_keyword_list', SearchAttributeType.KEYWORD_LIST, ['three', 'four', 'five']),
        // Note that 'typed_datetime' becomes a 'TEXT' string when serialized.
        searchAttributePair('typed_datetime', SearchAttributeType.TEXT, secondDate.toISOString()),
      ])
    );

    assertWorkflowDescSearchAttributes(
      t,
      desc,
      descExpected,
      new TypedSearchAttributes([
        searchAttributePair('typed_text', SearchAttributeType.TEXT, 'new_value'),
        searchAttributePair('typed_keyword', SearchAttributeType.KEYWORD, 'new_keyword'),
        searchAttributePair('typed_int', SearchAttributeType.INT, 2),
        searchAttributePair('typed_double', SearchAttributeType.DOUBLE, 2.34),
        searchAttributePair('typed_keyword_list', SearchAttributeType.KEYWORD_LIST, ['three', 'four', 'five']),
        searchAttributePair('typed_datetime', SearchAttributeType.DATETIME, secondDate),
      ])
    );

    // Update search attributes with typed input.
    await handle.signal(mutateSearchAttributes, typedUpdateAttrs);
    res = await handle.query(getWorkflowInfoWithMeta);
    desc = await handle.describe();

    // Note that we expect the empty array in the untyped search attributes.
    const expectedUntyped = {
      typed_text: ['even_newer_value'],
      typed_int: [3],
      typed_double: [3.45],
      typed_keyword_list: ['six', 'seven'],
      typed_bool: [false],
      typed_keyword: [],
      typed_datetime: [],
    };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { typed_keyword, typed_datetime, ...newDescExpected } = expectedUntyped;
    const expectedTyped = new TypedSearchAttributes([
      searchAttributePair('typed_text', SearchAttributeType.TEXT, 'even_newer_value'),
      searchAttributePair('typed_int', SearchAttributeType.INT, 3),
      searchAttributePair('typed_double', SearchAttributeType.DOUBLE, 3.45),
      searchAttributePair('typed_keyword_list', SearchAttributeType.KEYWORD_LIST, ['six', 'seven']),
      searchAttributePair('typed_bool', SearchAttributeType.BOOL, false),
    ]);

    assertWorkflowInfoSearchAttributes(t, res, expectedUntyped, expectedTyped);
    assertWorkflowDescSearchAttributes(t, desc, newDescExpected, expectedTyped);

    await handle.signal(complete);
  });
});

function assertWorkflowInfoSearchAttributes(
  t: ExecutionContext<Context>,
  res: WorkflowInfoWithMeta,
  searchAttributes: SearchAttributes,
  typedSearchAttributes: TypedSearchAttributes
) {
  // Check the instance of typedSearchAttributes in workflowInfo is of TypedSearchAttributes class.
  t.true(res.isTypedSearchAttributesInstance);

  // Check initial search attributes are present.
  // Response from query serializes datetime attributes to strings so we serialize our expected responses.
  t.deepEqual(res.info.searchAttributes, JSON.parse(JSON.stringify(searchAttributes)));
  t.deepEqual(res.info.typedSearchAttributes, JSON.parse(JSON.stringify(typedSearchAttributes)));
}

function assertWorkflowDescSearchAttributes(
  t: ExecutionContext<Context>,
  desc: WorkflowExecutionDescription,
  searchAttributes: SearchAttributes,
  typedSearchAttributes: TypedSearchAttributes
) {
  // Check that all search attributes are present in the workflow description's search attributes.
  t.like(desc.searchAttributes, searchAttributes);
  const descOmittingBuildIds = desc.typedSearchAttributes.updateSearchAttributes([
    searchAttributeUpdatePair('BuildIds', SearchAttributeType.BOOL, null),
  ]);
  t.deepEqual(descOmittingBuildIds, typedSearchAttributes);
}
