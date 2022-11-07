import { RUN_INTEGRATION_TESTS } from './helpers';
import anyTest, { TestInterface } from 'ava';
import { randomUUID } from 'crypto';
import { Client, Connection, defaultPayloadConverter } from '@temporalio/client';
import asyncRetry from 'async-retry';
import { msToNumber } from '@temporalio/common/lib/time';
import { CalendarSpec, CalendarSpecDescription, ScheduleSummary } from '@temporalio/client/lib/schedule-types';
import { ScheduleHandle } from '@temporalio/client/lib/schedule-client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { temporal } from '@temporalio/proto';
import * as grpc from '@grpc/grpc-js';

export interface Context {
  testEnv: TestWorkflowEnvironment;
  client: Client;
}

const taskQueue = 'async-activity-completion';
const test = anyTest as TestInterface<Context>;

const dummyWorkflow = async () => undefined;
const dummyWorkflow2 = async (_x?: string) => undefined;

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

test.before(async (t) => {
  const testEnv = await TestWorkflowEnvironment.createLocal();
  t.context = {
    testEnv,
    client: testEnv.client,
  };
  // In case we're running with temporalite or other non default server.
  // NOTE: at the time this was added temporalite did not expose the grpc OperatorService.
  try {
    await (testEnv.connection as Connection).operatorService.addSearchAttributes({
      searchAttributes: {
        CustomKeywordField: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
      },
    });
  } catch (err: any) {
    if (err.code !== grpc.status.ALREADY_EXISTS) {
      throw err;
    }
  }
  // The initialization of the custom search attributes is slooooow. Wait for it to finish
  await asyncRetry(
    async () => {
      const listSearchAttributesResponse = await (
        testEnv.connection as Connection
      ).operatorService.listSearchAttributes({});
      if (!('CustomKeywordField' in listSearchAttributesResponse.customAttributes))
        throw new Error('Custom search attribute "CustomKeywordField" missing');
    },
    {
      retries: 60,
      maxTimeout: 1000,
    }
  );
});

test.after.always(async (t) => {
  await t.context.testEnv?.teardown();
});

if (RUN_INTEGRATION_TESTS) {
  test('Can create schedule with calendar', async (t) => {
    const { client } = t.context;
    const scheduleId = `can-create-schedule-with-calendar-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
      },
      action: {
        type: 'startWorkflow',
        workflowId: `${scheduleId}-workflow`,
        workflowType: dummyWorkflow,
        taskQueue,
      },
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

  test('Can create schedule with intervals', async (t) => {
    const { client } = t.context;
    const scheduleId = `can-create-schedule-with-inteval-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        intervals: [{ every: '1h', offset: '5m' }],
      },
      action: {
        type: 'startWorkflow',
        workflowId: `${scheduleId}-workflow`,
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

  test('Can create schedule with cron syntax', async (t) => {
    const { client } = t.context;
    const scheduleId = `can-create-schedule-with-cron-syntax-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        cronExpressions: ['0 12 * * MON-WED,FRI'],
      },
      action: {
        type: 'startWorkflow',
        workflowId: `${scheduleId}-workflow`,
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

  test('Can create schedule with startWorkflow action', async (t) => {
    const { client } = t.context;
    const scheduleId = `can-create-schedule-with-startWorkflow-action-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
      },
      action: {
        type: 'startWorkflow',
        workflowId: `${scheduleId}-workflow`,
        workflowType: dummyWorkflow,
        taskQueue,
        memo: {
          'my-memo': 'foo',
        },
        searchAttributes: {
          CustomKeywordField: ['test-value2'],
        },
      },
    });

    try {
      const describedSchedule = await handle.describe();

      t.is(describedSchedule.action.type, 'startWorkflow');
      t.is(describedSchedule.action.workflowType, 'dummyWorkflow');
      t.deepEqual(describedSchedule.action.memo, { 'my-memo': 'foo' });
      t.deepEqual(describedSchedule.action.searchAttributes?.CustomKeywordField, ['test-value2']);
    } finally {
      await handle.delete();
    }
  });

  test('Interceptor is called on create schedule', async (t) => {
    const clientWithInterceptor = new Client({
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
        workflowId: `${scheduleId}-workflow`,
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

  test('Can pause and unpause schedule', async (t) => {
    const { client } = t.context;
    const scheduleId = `can-pause-and-unpause-schedule-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
      },
      action: {
        type: 'startWorkflow',
        workflowId: `${scheduleId}-workflow`,
        workflowType: dummyWorkflow,
        taskQueue,
        memo: {
          'my-memo': 'foo',
        },
        searchAttributes: {
          CustomKeywordField: ['test-value2'],
        },
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

  test('Can update schedule', async (t) => {
    const { client } = t.context;
    const scheduleId = `can-update-schedule-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
      },
      action: {
        type: 'startWorkflow',
        workflowId: `${scheduleId}-workflow`,
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

  test('Can update schedule action', async (t) => {
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
        workflowType: dummyWorkflow,
        taskQueue,
      },
    });

    try {
      await handle.update((x) => ({
        ...x,
        action: {
          type: 'startWorkflow',
          workflowId: `${scheduleId}-workflow-2`,
          workflowType: dummyWorkflow2,
          args: ['updated'],
          taskQueue,
        },
      }));

      const describedSchedule = await handle.describe();
      t.is(describedSchedule.action.type, 'startWorkflow');
      t.is(describedSchedule.action.workflowType, 'dummyWorkflow2');
      t.deepEqual(describedSchedule.action.args, ['updated']);
    } finally {
      await handle.delete();
    }
  });

  // FIXME: Reenable this test once temporalite has been upgraded to server 1.18.1+
  test.skip('Schedule updates throws without retry on validation error', async (t) => {
    const { client } = t.context;
    const scheduleId = `schedule-update-throws-without-retry-on-validation-error-${randomUUID()}`;
    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
      },
      action: {
        type: 'startWorkflow',
        workflowId: `${scheduleId}-workflow`,
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

  test('Can list Schedules', async (t) => {
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
            workflowId: `${scheduleId}-workflow`,
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
          if (createdSchedulesIds.length != listedScheduleIds.length) throw new Error('Missing list entries');

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

  test('Structured calendar specs are encoded and decoded properly', async (t) => {
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
        workflowId: `${scheduleId}-workflow`,
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
}
