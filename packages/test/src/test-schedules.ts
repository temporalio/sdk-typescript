import { randomUUID } from 'node:crypto';
import anyTest, { TestFn } from 'ava';
import asyncRetry from 'async-retry';
import {
  defaultPayloadConverter,
  CalendarSpec,
  CalendarSpecDescription,
  Client,
  Connection,
  ScheduleHandle,
  ScheduleSummary,
  ScheduleUpdateOptions,
  ScheduleDescription,
} from '@temporalio/client';
import { msToNumber } from '@temporalio/common/lib/time';
import {
  SearchAttributeType,
  SearchAttributes,
  TypedSearchAttributes,
  defineSearchAttributeKey,
} from '@temporalio/common';
import { registerDefaultCustomSearchAttributes, RUN_INTEGRATION_TESTS, waitUntil } from './helpers';
import { defaultSAKeys } from './helpers-integration';

export interface Context {
  client: Client;
}

const taskQueue = 'async-activity-completion';
const test = anyTest as TestFn<Context>;

const dummyWorkflow = async () => undefined;
const dummyWorkflowWith1Arg = async (_s: string) => undefined;
const dummyWorkflowWith2Args = async (_x: number, _y: number) => undefined;

const calendarSpecDescriptionDefaults: CalendarSpecDescription = {
  second: [{ start: 0, end: 0, step: 1 }],
  minute: [{ start: 0, end: 0, step: 1 }],
  hour: [{ start: 0, end: 0, step: 1 }],
  dayOfMonth: [{ start: 1, end: 31, step: 1 }],
  month: [{ start: 'JANUARY', end: 'DECEMBER', step: 1 }],
  dayOfWeek: [{ start: 'SUNDAY', end: 'SATURDAY', step: 1 }],
  year: [],
  comment: '',
};

if (RUN_INTEGRATION_TESTS) {
  test.before(async (t) => {
    const connection = await Connection.connect();
    await registerDefaultCustomSearchAttributes(connection);
    t.context = {
      client: new Client({ connection }),
    };
  });

  test.serial('Can create schedule with calendar', async (t) => {
    const { client } = t.context;
    const scheduleId = `can-create-schedule-with-calendar-${randomUUID()}`;
    const action = {
      type: 'startWorkflow',
      workflowType: dummyWorkflow,
      taskQueue,
    } as const;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
      },
      action,
    });

    try {
      const describedSchedule = await handle.describe();
      t.deepEqual(describedSchedule.spec.calendars, [
        { ...calendarSpecDescriptionDefaults, hour: [{ start: 2, end: 7, step: 1 }] },
      ]);
    } finally {
      await handle.delete();
    }
  });

  test.serial('Can create schedule with intervals', async (t) => {
    const { client } = t.context;
    const scheduleId = `can-create-schedule-with-inteval-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        intervals: [{ every: '1h', offset: '5m' }],
      },
      action: {
        type: 'startWorkflow',
        workflowType: dummyWorkflow,
        taskQueue,
      },
    });

    try {
      const describedSchedule = await handle.describe();
      t.deepEqual(describedSchedule.spec.intervals, [{ every: msToNumber('1h'), offset: msToNumber('5m') }]);
    } finally {
      await handle.delete();
    }
  });

  test.serial('Can create schedule with cron syntax', async (t) => {
    const { client } = t.context;
    const scheduleId = `can-create-schedule-with-cron-syntax-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        cronExpressions: ['0 12 * * MON-WED,FRI'],
      },
      action: {
        type: 'startWorkflow',
        workflowType: dummyWorkflow,
        taskQueue,
      },
    });

    try {
      const describedSchedule = await handle.describe();
      t.deepEqual(describedSchedule.spec.calendars, [
        {
          ...calendarSpecDescriptionDefaults,
          hour: [{ start: 12, end: 12, step: 1 }],
          dayOfWeek: [
            { start: 'MONDAY', end: 'WEDNESDAY', step: 1 },
            { start: 'FRIDAY', end: 'FRIDAY', step: 1 },
          ],
        },
      ]);
    } finally {
      await handle.delete();
    }
  });

  test.serial('Can create schedule without any spec', async (t) => {
    const { client } = t.context;
    const scheduleId = `can-create-schedule-without-any-spec-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {},
      action: {
        type: 'startWorkflow',
        workflowType: dummyWorkflow,
        taskQueue,
      },
    });

    try {
      const describedSchedule = await handle.describe();
      t.deepEqual(describedSchedule.spec.calendars, []);
      t.deepEqual(describedSchedule.spec.intervals, []);
      t.deepEqual(describedSchedule.spec.skip, []);
    } finally {
      await handle.delete();
    }
  });

  test.serial('Can create schedule with startWorkflow action (no arg)', async (t) => {
    const { client } = t.context;
    const scheduleId = `can-create-schedule-with-startWorkflow-action-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
      },
      action: {
        type: 'startWorkflow',
        workflowType: dummyWorkflow,
        taskQueue,
        memo: {
          'my-memo': 'foo',
        },
        searchAttributes: {
          CustomKeywordField: ['test-value2'],
        },
        typedSearchAttributes: new TypedSearchAttributes([{ key: defaultSAKeys.CustomIntField, value: 42 }]),
      },
    });

    try {
      const describedSchedule = await handle.describe();

      t.is(describedSchedule.action.type, 'startWorkflow');
      t.is(describedSchedule.action.workflowType, 'dummyWorkflow');
      t.deepEqual(describedSchedule.action.memo, { 'my-memo': 'foo' });
      // eslint-disable-next-line deprecation/deprecation
      t.deepEqual(describedSchedule.action.searchAttributes, {
        CustomKeywordField: ['test-value2'],
        CustomIntField: [42],
      });
      t.deepEqual(
        describedSchedule.action.typedSearchAttributes,
        new TypedSearchAttributes([
          { key: defaultSAKeys.CustomIntField, value: 42 },
          { key: defaultSAKeys.CustomKeywordField, value: 'test-value2' },
        ])
      );
    } finally {
      await handle.delete();
    }
  });

  test.serial('Can create schedule with startWorkflow action (with args)', async (t) => {
    const { client } = t.context;
    const scheduleId = `can-create-schedule-with-startWorkflow-action-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
      },
      action: {
        type: 'startWorkflow',
        workflowType: dummyWorkflowWith2Args,
        args: [3, 4],
        taskQueue,
        memo: {
          'my-memo': 'foo',
        },
        searchAttributes: {
          CustomKeywordField: ['test-value2'],
        },
        typedSearchAttributes: new TypedSearchAttributes([{ key: defaultSAKeys.CustomIntField, value: 42 }]),
      },
    });

    try {
      const describedSchedule = await handle.describe();

      t.is(describedSchedule.action.type, 'startWorkflow');
      t.is(describedSchedule.action.workflowType, 'dummyWorkflowWith2Args');
      t.deepEqual(describedSchedule.action.args, [3, 4]);
      t.deepEqual(describedSchedule.action.memo, { 'my-memo': 'foo' });
      // eslint-disable-next-line deprecation/deprecation
      t.deepEqual(describedSchedule.action.searchAttributes, {
        CustomKeywordField: ['test-value2'],
        CustomIntField: [42],
      });
      t.deepEqual(
        describedSchedule.action.typedSearchAttributes,
        new TypedSearchAttributes([
          { key: defaultSAKeys.CustomIntField, value: 42 },
          { key: defaultSAKeys.CustomKeywordField, value: 'test-value2' },
        ])
      );
    } finally {
      await handle.delete();
    }
  });

  test.serial('Interceptor is called on create schedule', async (t) => {
    const clientWithInterceptor = new Client({
      connection: t.context.client.connection,
      interceptors: {
        schedule: [
          {
            async create(input, next) {
              return next({
                ...input,
                headers: {
                  intercepted: defaultPayloadConverter.toPayload('intercepted'),
                },
              });
            },
          },
        ],
      },
    });

    const scheduleId = `interceptor-called-on-create-schedule-${randomUUID()}`;
    const handle = await clientWithInterceptor.schedule.create({
      scheduleId,
      spec: {
        intervals: [{ every: '1h', offset: '5m' }],
      },
      action: {
        type: 'startWorkflow',
        workflowType: dummyWorkflow,
        taskQueue,
      },
    });

    try {
      const describedSchedule = await handle.describe();
      const outHeaders = describedSchedule.raw.schedule?.action?.startWorkflow?.header;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      t.is(defaultPayloadConverter.fromPayload(outHeaders!.fields!.intercepted!), 'intercepted');
    } finally {
      await handle.delete();
    }
  });

  test.serial('startWorkflow headers are kept on update', async (t) => {
    const clientWithInterceptor = new Client({
      connection: t.context.client.connection,
      interceptors: {
        schedule: [
          {
            async create(input, next) {
              return next({
                ...input,
                headers: {
                  intercepted: defaultPayloadConverter.toPayload('intercepted'),
                },
              });
            },
          },
        ],
      },
    });

    const scheduleId = `startWorkflow-headerskept-on-update-${randomUUID()}`;
    const handle = await clientWithInterceptor.schedule.create({
      scheduleId,
      spec: {
        intervals: [{ every: '1h', offset: '5m' }],
      },
      action: {
        type: 'startWorkflow',
        workflowType: dummyWorkflow,
        taskQueue,
      },
    });

    try {
      // Actually perform no change to the schedule
      await handle.update((x) => x);

      const describedSchedule = await handle.describe();
      const outHeaders = describedSchedule.raw.schedule?.action?.startWorkflow?.header;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      t.is(defaultPayloadConverter.fromPayload(outHeaders!.fields!.intercepted!), 'intercepted');
    } finally {
      await handle.delete();
    }
  });

  test.serial('Can pause and unpause schedule', async (t) => {
    const { client } = t.context;
    const scheduleId = `can-pause-and-unpause-schedule-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
      },
      action: {
        type: 'startWorkflow',
        workflowType: dummyWorkflow,
        taskQueue,
        memo: {
          'my-memo': 'foo',
        },
        searchAttributes: {
          CustomKeywordField: ['test-value2'],
        },
        typedSearchAttributes: new TypedSearchAttributes([{ key: defaultSAKeys.CustomIntField, value: 42 }]),
      },
    });

    try {
      let describedSchedule = await handle.describe();
      t.false(describedSchedule.state.paused);

      await handle.pause();
      describedSchedule = await handle.describe();
      t.true(describedSchedule.state.paused);

      await handle.unpause();
      describedSchedule = await handle.describe();
      t.false(describedSchedule.state.paused);
    } finally {
      await handle.delete();
    }
  });

  test.serial('Can update schedule calendar', async (t) => {
    const { client } = t.context;
    const scheduleId = `can-update-schedule-calendar-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
      },
      action: {
        type: 'startWorkflow',
        workflowType: dummyWorkflow,
        taskQueue,
      },
    });

    try {
      await handle.update((x) => ({
        ...x,
        spec: {
          calendars: [{ hour: { start: 6, end: 9, step: 1 } }],
        },
      }));

      const describedSchedule = await handle.describe();
      t.deepEqual(describedSchedule.spec.calendars, [
        { ...calendarSpecDescriptionDefaults, hour: [{ start: 6, end: 9, step: 1 }] },
      ]);
    } finally {
      await handle.delete();
    }
  });

  test.serial('Can update schedule action', async (t) => {
    const { client } = t.context;
    const scheduleId = `can-update-schedule-action-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
      },
      action: {
        type: 'startWorkflow',
        workflowId: `${scheduleId}-workflow`,
        workflowType: dummyWorkflowWith1Arg,
        args: ['foo'],
        taskQueue,
      },
    });

    try {
      await handle.update((x) => ({
        ...x,
        action: {
          type: 'startWorkflow',
          workflowType: dummyWorkflowWith2Args,
          args: [3, 4],
          taskQueue,
        },
      }));

      const describedSchedule = await handle.describe();
      t.is(describedSchedule.action.type, 'startWorkflow');
      t.is(describedSchedule.action.workflowType, 'dummyWorkflowWith2Args');
      t.deepEqual(describedSchedule.action.args, [3, 4]);
    } finally {
      await handle.delete();
    }
  });

  test.serial('Can update schedule intervals', async (t) => {
    const { client } = t.context;
    const scheduleId = `can-update-schedule-intervals-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        intervals: [{ every: '5h' }],
      },
      action: {
        type: 'startWorkflow',
        workflowId: `${scheduleId}-workflow`,
        workflowType: dummyWorkflowWith1Arg,
        args: ['foo'],
        taskQueue,
      },
    });

    try {
      await handle.update((x: ScheduleUpdateOptions) => {
        x.spec.intervals = [{ every: '3h' }];
        return x;
      });

      const describedSchedule = await handle.describe();
      t.is(describedSchedule.action.type, 'startWorkflow');
      t.is(describedSchedule.action.workflowType, 'dummyWorkflowWith1Arg');
      t.deepEqual(describedSchedule.action.args, ['foo']);
    } finally {
      await handle.delete();
    }
  });

  test.serial('Schedule updates throws without retry on validation error', async (t) => {
    const { client } = t.context;
    const scheduleId = `schedule-update-throws-without-retry-on-validation-error-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
      },
      action: {
        type: 'startWorkflow',
        workflowType: dummyWorkflow,
        taskQueue,
      },
    });

    try {
      let retryCount = 0;

      await t.throwsAsync(
        async (): Promise<void> => {
          retryCount++;
          return handle.update((previous) => ({
            ...previous,
            spec: {
              calendars: [{ hour: 42 }],
            },
          }));
        },
        {
          instanceOf: TypeError,
        }
      );

      t.is(retryCount, 1);
    } finally {
      await handle.delete();
    }
  });

  test.serial('Can list Schedules', async (t) => {
    const { client } = t.context;

    const groupId = randomUUID();

    const createdScheduleHandlesPromises = [];
    for (let i = 10; i < 30; i++) {
      const scheduleId = `can-list-schedule-${groupId}-${i}`;
      createdScheduleHandlesPromises.push(
        client.schedule.create({
          scheduleId,
          spec: {
            calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
          },
          action: {
            type: 'startWorkflow',
            workflowType: dummyWorkflow,
            taskQueue,
          },
        })
      );
    }
    const createdScheduleHandles: { [k: string]: ScheduleHandle } = Object.fromEntries(
      (await Promise.all(createdScheduleHandlesPromises)).map((x) => [x.scheduleId, x])
    );

    try {
      // Wait for visibility to stabilize
      await asyncRetry(
        async () => {
          const listedScheduleHandles: ScheduleSummary[] = [];
          // Page size is intentionnally low to guarantee multiple pages
          for await (const schedule of client.schedule.list({ pageSize: 6 })) {
            listedScheduleHandles.push(schedule);
          }

          const listedScheduleIds = listedScheduleHandles
            .map((x) => x.scheduleId)
            .filter((x) => x.startsWith(`can-list-schedule-${groupId}-`))
            .sort();

          const createdSchedulesIds = Object.values(createdScheduleHandles).map((x) => x.scheduleId);
          if (createdSchedulesIds.length !== listedScheduleIds.length) throw new Error('Missing list entries');

          t.deepEqual(listedScheduleIds, createdSchedulesIds);
        },
        {
          retries: 60,
          maxTimeout: 1000,
        }
      );

      t.pass();
    } finally {
      for (const handle of Object.values(createdScheduleHandles)) {
        await handle.delete();
      }
    }
  });

  test.serial('Can list Schedules with a query string', async (t) => {
    const { client } = t.context;

    const groupId = randomUUID();
    const createdScheduleHandlesPromises = [];
    const expectedIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const scheduleId = `test-query-${groupId}-${i + 1}`;
      const searchAttributes: SearchAttributes = {}; // eslint-disable-line deprecation/deprecation
      if (i < 2) {
        searchAttributes['CustomKeywordField'] = ['some-value'];
        expectedIds.push(scheduleId);
      }
      createdScheduleHandlesPromises.push(
        client.schedule.create({
          scheduleId,
          spec: {
            calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
          },
          action: {
            type: 'startWorkflow',
            workflowType: dummyWorkflow,
            taskQueue,
          },
          searchAttributes,
          typedSearchAttributes: new TypedSearchAttributes([{ key: defaultSAKeys.CustomIntField, value: 42 }]),
        })
      );
    }

    const createdScheduleHandles: { [k: string]: ScheduleHandle } = Object.fromEntries(
      (await Promise.all(createdScheduleHandlesPromises)).map((x) => [x.scheduleId, x])
    );

    try {
      // Wait for visibility to stabilize
      await asyncRetry(
        async () => {
          const listedScheduleHandlesFromQuery: ScheduleSummary[] = []; // to list all the schedule handles from the query string provided
          const query = `CustomKeywordField="some-value"`;

          for await (const schedule of client.schedule.list({ query })) {
            listedScheduleHandlesFromQuery.push(schedule);
          }

          const listedScheduleIdsFromQuery = listedScheduleHandlesFromQuery.map((x) => x.scheduleId).sort();

          if (listedScheduleIdsFromQuery.length !== expectedIds.length) throw new Error('Entries are missing');

          t.deepEqual(listedScheduleIdsFromQuery, expectedIds);
        },
        {
          retries: 60,
          maxTimeout: 1000,
        }
      );

      t.pass();
    } finally {
      for (const handle of Object.values(createdScheduleHandles)) {
        await handle.delete();
      }
    }
  });

  test.serial('Structured calendar specs are encoded and decoded properly', async (t) => {
    const checks: { input: CalendarSpec; expected: CalendarSpecDescription; comment?: string }[] = [
      {
        comment: 'a single value X encode to a range in the form { X, X, 1 }',
        input: {
          hour: 4,
          dayOfWeek: 'MONDAY',
          month: 'APRIL',
        },
        expected: {
          ...calendarSpecDescriptionDefaults,
          hour: [{ start: 4, end: 4, step: 1 }],
          dayOfWeek: [{ start: 'MONDAY', end: 'MONDAY', step: 1 }],
          month: [{ start: 'APRIL', end: 'APRIL', step: 1 }],
        },
      },
      {
        comment: 'match all ranges are exact',
        input: {
          second: '*',
          minute: '*',
          hour: '*',
          dayOfMonth: '*',
          month: '*',
          year: '*',
          dayOfWeek: '*',
        },
        expected: {
          ...calendarSpecDescriptionDefaults,
          second: [{ start: 0, end: 59, step: 1 }],
          minute: [{ start: 0, end: 59, step: 1 }],
          hour: [{ start: 0, end: 23, step: 1 }],
          dayOfMonth: [{ start: 1, end: 31, step: 1 }],
          month: [{ start: 'JANUARY', end: 'DECEMBER', step: 1 }],
          year: [],
          dayOfWeek: [{ start: 'SUNDAY', end: 'SATURDAY', step: 1 }],
        },
      },
      {
        comment: 'a mixed array of values and ranges encode properly',
        input: {
          hour: [4, 7, 9, { start: 15, end: 20, step: 2 }],
          dayOfWeek: ['FRIDAY', 'SATURDAY', { start: 'TUESDAY', end: 'FRIDAY', step: 1 }],
          month: ['DECEMBER', 'JANUARY', { start: 'APRIL', end: 'JULY', step: 3 }],
        },
        expected: {
          ...calendarSpecDescriptionDefaults,
          hour: [
            { start: 4, end: 4, step: 1 },
            { start: 7, end: 7, step: 1 },
            { start: 9, end: 9, step: 1 },
            { start: 15, end: 20, step: 2 },
          ],
          dayOfWeek: [
            { start: 'FRIDAY', end: 'FRIDAY', step: 1 },
            { start: 'SATURDAY', end: 'SATURDAY', step: 1 },
            { start: 'TUESDAY', end: 'FRIDAY', step: 1 },
          ],
          month: [
            { start: 'DECEMBER', end: 'DECEMBER', step: 1 },
            { start: 'JANUARY', end: 'JANUARY', step: 1 },
            { start: 'APRIL', end: 'JULY', step: 3 },
          ],
        },
      },
      {
        input: {
          hour: [
            { start: 2, end: 7 },
            { start: 2, end: 7, step: 1 },
            { start: 2, end: 7, step: 1 },
            { start: 2, end: 7, step: 2 },
            { start: 4, end: 0, step: 2 },
          ],
        },
        expected: {
          ...calendarSpecDescriptionDefaults,
          hour: [
            { start: 2, end: 7, step: 1 },
            { start: 2, end: 7, step: 1 },
            { start: 2, end: 7, step: 1 },
            { start: 2, end: 7, step: 2 },
            { start: 4, end: 4, step: 2 },
          ],
        },
      },
      {
        input: { hour: 4 },
        expected: { ...calendarSpecDescriptionDefaults, hour: [{ start: 4, end: 4, step: 1 }] },
      },
    ];

    const { client } = t.context;
    const scheduleId = `structured-schedule-specs-encoding-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        calendars: checks.map(({ input }) => input),
      },
      action: {
        type: 'startWorkflow',
        workflowType: dummyWorkflow,
        taskQueue,
      },
    });

    try {
      const describedSchedule = await handle.describe();
      const describedCalendars = describedSchedule.spec.calendars ?? [];

      t.is(describedCalendars.length, checks.length);
      for (let i = 0; i < checks.length; i++) {
        t.deepEqual(describedCalendars[i], checks[i].expected, checks[i].comment);
      }
    } finally {
      await handle.delete();
    }
  });

  test.serial('Can update search attributes of a schedule', async (t) => {
    const { client } = t.context;
    const scheduleId = `can-update-search-attributes-of-schedule-${randomUUID()}`;

    // Helper to wait for search attribute changes to propagate.
    const waitForAttributeChange = async (
      handle: ScheduleHandle,
      attributeName: string,
      shouldExist: boolean
    ): Promise<ScheduleDescription> => {
      await waitUntil(async () => {
        const desc = await handle.describe();
        const exists =
          desc.typedSearchAttributes.getAll().find((pair) => pair.key.name === attributeName) !== undefined;
        return exists === shouldExist;
      }, 5000);
      return await handle.describe();
    };

    // Create a schedule with search attributes.
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
      },
      action: {
        type: 'startWorkflow',
        workflowType: dummyWorkflow,
        taskQueue,
      },
      searchAttributes: {
        CustomKeywordField: ['keyword-one'],
      },
      typedSearchAttributes: [{ key: defineSearchAttributeKey('CustomIntField', SearchAttributeType.INT), value: 1 }],
    });

    // Check the search attributes are part of the schedule description.
    const desc = await handle.describe();
    // eslint-disable-next-line deprecation/deprecation
    t.deepEqual(desc.searchAttributes, {
      CustomKeywordField: ['keyword-one'],
      CustomIntField: [1],
    });
    t.deepEqual(
      desc.typedSearchAttributes,
      new TypedSearchAttributes([
        { key: defineSearchAttributeKey('CustomIntField', SearchAttributeType.INT), value: 1 },
        { key: defineSearchAttributeKey('CustomKeywordField', SearchAttributeType.KEYWORD), value: 'keyword-one' },
      ])
    );

    // Perform a series of updates to schedule's search attributes.
    try {
      // Update existing search attributes, add new ones.
      await handle.update((desc) => ({
        ...desc,
        searchAttributes: {
          CustomKeywordField: ['keyword-two'],
          // Add a new search attribute.
          CustomDoubleField: [1.5],
        },
        typedSearchAttributes: [
          { key: defineSearchAttributeKey('CustomIntField', SearchAttributeType.INT), value: 2 },
          // Add a new typed search attribute.
          { key: defineSearchAttributeKey('CustomTextField', SearchAttributeType.TEXT), value: 'new-text' },
        ],
      }));

      let desc = await waitForAttributeChange(handle, 'CustomTextField', true);
      // eslint-disable-next-line deprecation/deprecation
      t.deepEqual(desc.searchAttributes, {
        CustomKeywordField: ['keyword-two'],
        CustomIntField: [2],
        CustomDoubleField: [1.5],
        CustomTextField: ['new-text'],
      });
      t.deepEqual(
        desc.typedSearchAttributes,
        new TypedSearchAttributes([
          { key: defineSearchAttributeKey('CustomIntField', SearchAttributeType.INT), value: 2 },
          { key: defineSearchAttributeKey('CustomKeywordField', SearchAttributeType.KEYWORD), value: 'keyword-two' },
          { key: defineSearchAttributeKey('CustomTextField', SearchAttributeType.TEXT), value: 'new-text' },
          { key: defineSearchAttributeKey('CustomDoubleField', SearchAttributeType.DOUBLE), value: 1.5 },
        ])
      );

      // Update and remove some search attributes. We remove a search attribute by omitting an existing key from the update.
      await handle.update((desc) => ({
        ...desc,
        searchAttributes: {
          CustomKeywordField: ['keyword-three'],
        },
        typedSearchAttributes: [{ key: defineSearchAttributeKey('CustomIntField', SearchAttributeType.INT), value: 3 }],
      }));

      desc = await waitForAttributeChange(handle, 'CustomTextField', false);
      // eslint-disable-next-line deprecation/deprecation
      t.deepEqual(desc.searchAttributes, {
        CustomKeywordField: ['keyword-three'],
        CustomIntField: [3],
      });
      t.deepEqual(
        desc.typedSearchAttributes,
        new TypedSearchAttributes([
          { key: defineSearchAttributeKey('CustomIntField', SearchAttributeType.INT), value: 3 },
          { key: defineSearchAttributeKey('CustomKeywordField', SearchAttributeType.KEYWORD), value: 'keyword-three' },
        ])
      );

      // Remove all search attributes.
      await handle.update((desc) => ({
        ...desc,
        searchAttributes: {},
        typedSearchAttributes: [],
      }));

      desc = await waitForAttributeChange(handle, 'CustomIntField', false);
      t.deepEqual(desc.searchAttributes, {}); // eslint-disable-line deprecation/deprecation
      t.deepEqual(desc.typedSearchAttributes, new TypedSearchAttributes([]));
    } finally {
      await handle.delete();
    }
  });

  test.serial('User metadata on schedule', async (t) => {
    const { client } = t.context;
    const scheduleId = `schedule-with-user-metadata-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {},
      action: {
        type: 'startWorkflow',
        workflowType: dummyWorkflow,
        taskQueue,
        staticSummary: 'schedule static summary',
        staticDetails: 'schedule static details',
      },
    });

    try {
      const describedSchedule = await handle.describe();
      t.deepEqual(describedSchedule.spec.calendars, []);
      t.deepEqual(describedSchedule.spec.intervals, []);
      t.deepEqual(describedSchedule.spec.skip, []);
      t.deepEqual(describedSchedule.action.staticSummary, 'schedule static summary');
      t.deepEqual(describedSchedule.action.staticDetails, 'schedule static details');
    } finally {
      await handle.delete();
    }
  });
}
