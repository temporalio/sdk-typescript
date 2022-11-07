import { RUN_INTEGRATION_TESTS } from './helpers';
import anyTest, { TestInterface } from 'ava';
import { Client, defaultPayloadConverter } from '@temporalio/client';
import { uuid4 } from '@temporalio/workflow';
import { msToNumber } from '@temporalio/common/lib/time';
import { CalendarSpec, CalendarSpecDescription } from '@temporalio/client/lib/schedule-types';
import { InvalidScheduleSpecError } from '@temporalio/client/lib/schedule-client';

export interface Context {
  client: Client;
}

const taskQueue = 'async-activity-completion';
const test = anyTest as TestInterface<Context>;

const dummyWorkflow = async () => undefined;

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
  t.context = {
    client: new Client(),
  };
});

if (RUN_INTEGRATION_TESTS) {
  test('Can create schedule with calendar', async (t) => {
    const { client } = t.context;
    const scheduleId = uuid4();
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

    const describedSchedule = await handle.describe();
    t.deepEqual(describedSchedule.spec.calendars, [
      { ...calendarSpecDescriptionDefaults, hour: [{ start: 2, end: 7, step: 1 }] },
    ]);

    await handle.delete();
  });

  test('Can create schedule with startWorkflow action', async (t) => {
    const { client } = t.context;
    const scheduleId = uuid4();
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

    const describedSchedule = await handle.describe();

    t.deepEqual(describedSchedule.action.type, 'startWorkflow');
    t.deepEqual(describedSchedule.action.workflowType, 'dummyWorkflow');
    t.deepEqual(describedSchedule.action.memo, { 'my-memo': 'foo' });
    t.deepEqual(describedSchedule.action.searchAttributes?.CustomKeywordField, ['test-value2']);

    await handle.delete();
  });

  test('Interceptor is called on create schedule', async (t) => {
    const clientWithInterceptor = new Client({
      interceptors: {
        schedule: {
          calls: [
            (interceptorFactoryInput) => ({
              async create(input, next) {
                return next({
                  ...input,
                  headers: {
                    scheduleId: defaultPayloadConverter.toPayload(interceptorFactoryInput.scheduleId),
                    intercepted: defaultPayloadConverter.toPayload('intercepted'),
                  },
                });
              },
            }),
          ],
        },
      },
    });

    const scheduleId = uuid4();
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

    const describedSchedule = await handle.describe();
    const outHeaders = describedSchedule.raw.schedule?.action?.startWorkflow?.header;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    t.deepEqual(scheduleId, defaultPayloadConverter.fromPayload(outHeaders!.fields!.scheduleId!));
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    t.deepEqual('intercepted', defaultPayloadConverter.fromPayload(outHeaders!.fields!.intercepted!));

    await handle.delete();
  });

  test('Can pause and unpause schedule', async (t) => {
    const { client } = t.context;
    const scheduleId = uuid4();
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

    let describedSchedule = await handle.describe();
    t.is(false, describedSchedule.paused);

    await handle.pause();
    describedSchedule = await handle.describe();
    t.is(true, describedSchedule.paused);

    await handle.unpause();
    describedSchedule = await handle.describe();
    t.is(false, describedSchedule.paused);

    await handle.delete();
  });

  test('Can update schedule multiple time', async (t) => {
    const { client } = t.context;
    const scheduleId = uuid4();
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

    await handle.delete();
  });

  test('Schedule updates throws without retry on validation error', async (t) => {
    const { client } = t.context;
    const scheduleId = uuid4();
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
        instanceOf: InvalidScheduleSpecError,
      }
    );

    t.is(retryCount, 1);

    await handle.delete();
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
    const scheduleId = uuid4();
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

    const describedSchedule = await handle.describe();
    const describedCalendars = describedSchedule.spec.calendars ?? [];

    t.is(checks.length, describedCalendars.length);
    for (let i = 0; i < checks.length; i++) {
      t.deepEqual(checks[i].expected, describedCalendars[i], checks[i].comment);
    }

    await handle.delete();
  });

  test('Can create schedule with intervals', async (t) => {
    const { client } = t.context;
    const scheduleId = uuid4();
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

    const describedSchedule = await handle.describe();
    t.deepEqual(describedSchedule.spec.intervals, [{ every: msToNumber('1h'), offset: msToNumber('5m') }]);

    await handle.delete();
  });
}
