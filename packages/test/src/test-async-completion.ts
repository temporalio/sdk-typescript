import type { TestFn, ExecutionContext } from 'ava';
import anyTest from 'ava';
import type { Observable } from 'rxjs';
import { Subject, firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import { v4 as uuid4 } from 'uuid';
import {
  ActivityCancelledError,
  Client,
  ActivityNotFoundError,
  WorkflowFailedError,
  Connection,
} from '@temporalio/client';
import type { Info } from '@temporalio/activity';
import type { ActivitySerializationContext, Payload } from '@temporalio/common';
import { ApplicationFailure, defaultPayloadConverter, fromPayloadsAtIndex, rootCause } from '@temporalio/common';
import { isCancellation } from '@temporalio/workflow';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { runAnAsyncActivity } from './workflows';
import { createActivities } from './activities/async-completer';
import { activityCtx, enc, makeContextTrace } from './payload-converters/serialization-context-converter';
import type { ContextTrace } from './payload-converters/serialization-context-converter';

export interface Context {
  worker: Worker;
  client: Client;
  activityStarted$: Observable<Info>;
  runPromise: Promise<void>;
  notFoundTaskToken: Uint8Array;
}

// This is a valid server generated token. Since the token contains the id of the namespace from
// which it was generated, trying to use it as-is will produce a namespace not found error. To avoid
// this, use `makeNotFoundTaskToken` to replace the namespace Id by the one of the current namespace.
// Protobuf reference: https://github.com/temporalio/temporal/blob/7314ea42e92f09e42d4edef76cbb5cee00b6c74c/proto/internal/temporal/server/api/token/v1/message.proto#L54
const NOT_FOUND_TASK_TOKEN = new Uint8Array([
  // 1. Namespace Id: string (len 36, UUID format)
  10, 36, 52, 101, 98, 48, 102, 49, 56, 52, 45, 101, 48, 51, 49, 45, 52, 52, 102, 97, 45, 56, 98, 48, 99, 45, 102, 48,
  50, 55, 100, 48, 53, 53, 98, 101, 100, 99,
  // 2. Workflow Id: string (len 36, UUID format)
  18, 36, 99, 55, 56, 55, 102, 55, 97, 102, 45, 50, 51, 99, 52, 45, 52, 56, 54, 98, 45, 57, 56, 98, 50, 45, 102, 53, 55,
  57, 57, 55, 97, 100, 48, 97, 101, 54,
  // 3. Run Id: string (len 36, UUID format)
  26, 36, 51, 51, 102, 101, 49, 50, 99, 56, 45, 98, 101, 52, 57, 45, 52, 49, 97, 50, 45, 56, 97, 98, 100, 45, 49, 55,
  54, 53, 52, 57, 54, 101, 100, 101, 57, 101,
  // 4. Scheduled Event Id: int64
  32, 5,
  // 5. Attempt: int32
  40, 1,
  // 6. Activity Id: string (len 1)
  50, 1, 49,
  // 8. Activity Type: string (len 13)
  66, 13, 99, 111, 109, 112, 108, 101, 116, 101, 65, 115, 121, 110, 99,
]);

//
async function makeNotFoundTaskToken(conn: Connection, namespace: string): Promise<Uint8Array> {
  const { namespaceInfo } = await conn.workflowService.describeNamespace({ namespace });
  const buf = Buffer.alloc(NOT_FOUND_TASK_TOKEN.length);
  buf.set(NOT_FOUND_TASK_TOKEN);
  buf.subarray(2, 38).set(Buffer.from(namespaceInfo?.id as string));
  return new Uint8Array(buf);
}

const taskQueue = 'async-activity-completion';
const test = anyTest as TestFn<Context>;
const TASK_TOKEN = new Uint8Array([1]);

async function activityStarted(t: ExecutionContext<Context>, id: string): Promise<Info> {
  return await firstValueFrom(
    t.context.activityStarted$.pipe(filter((info) => (info.workflowExecution?.workflowId || info.activityId) === id))
  );
}

function activitySerializationContext(
  namespace: string,
  workflowId: string,
  activityId: string
): ActivitySerializationContext {
  return {
    type: 'activity',
    namespace,
    workflowId,
    activityId,
    isLocal: false,
  };
}

interface PayloadsContainer {
  payloads?: Payload[] | null;
}

interface FailureRequest {
  failure: {
    message?: string | null;
    applicationFailureInfo?: {
      details?: PayloadsContainer | null;
    } | null;
  };
}

interface DetailsRequest {
  details?: PayloadsContainer | null;
}

function record<T>(requests: T[], response?: unknown): (request: T) => Promise<unknown> {
  return async (request) => {
    requests.push(request);
    return response;
  };
}

function makeTestClient() {
  const recorded = {
    respondActivityTaskFailed: [] as FailureRequest[],
    respondActivityTaskFailedById: [] as FailureRequest[],
    respondActivityTaskCanceled: [] as DetailsRequest[],
    respondActivityTaskCanceledById: [] as DetailsRequest[],
    recordActivityTaskHeartbeat: [] as DetailsRequest[],
    recordActivityTaskHeartbeatById: [] as DetailsRequest[],
  };

  const workflowService = {
    respondActivityTaskFailed: record(recorded.respondActivityTaskFailed),
    respondActivityTaskFailedById: record(recorded.respondActivityTaskFailedById),
    respondActivityTaskCanceled: record(recorded.respondActivityTaskCanceled),
    respondActivityTaskCanceledById: record(recorded.respondActivityTaskCanceledById),
    recordActivityTaskHeartbeat: record(recorded.recordActivityTaskHeartbeat, {}),
    recordActivityTaskHeartbeatById: record(recorded.recordActivityTaskHeartbeatById, {}),
  };

  const connection = {
    workflowService,
    plugins: [],
    close: async () => undefined,
    ensureConnected: async () => undefined,
    withDeadline: async <T>(_deadline: number | Date, fn: () => Promise<T>): Promise<T> => await fn(),
    withMetadata: async <T>(_metadata: Record<string, unknown>, fn: () => Promise<T>): Promise<T> => await fn(),
    withAbortSignal: async <T>(_abortSignal: AbortSignal, fn: () => Promise<T>): Promise<T> => await fn(),
  } as unknown as Connection;

  return {
    client: new Client({
      connection,
      dataConverter: {
        payloadConverterPath: require.resolve('./payload-converters/serialization-context-converter'),
        failureConverterPath: require.resolve('./payload-converters/serialization-context-converter'),
      },
    }),
    recorded,
  };
}

function expectEncodedWith(
  t: ExecutionContext<Context>,
  payloads: Payload[] | null | undefined,
  label: string,
  ctx: string
): void {
  t.truthy(payloads, 'encoded payloads must be present');
  t.deepEqual(fromPayloadsAtIndex<ContextTrace<string>>(defaultPayloadConverter, 0, payloads), {
    label,
    trace: [enc(label, ctx)],
  });
}

test('AsyncCompletionClient fail by full ID infers activity context', async (t) => {
  const { client, recorded } = makeTestClient();
  const ctx = activityCtx('wf1', 'act1');

  await client.activity.fail(
    { workflowId: 'wf1', activityId: 'act1' },
    ApplicationFailure.nonRetryable('boom', 'Error', makeContextTrace('detail'))
  );

  t.is(recorded.respondActivityTaskFailedById.length, 1);
  const request = recorded.respondActivityTaskFailedById[0]!;
  expectEncodedWith(t, request.failure.applicationFailureInfo?.details?.payloads, 'detail', ctx);
  t.is(request.failure.message, `failure.encode.bound|${ctx}|boom`);
});

test('AsyncCompletionClient fail with task token uses explicit activity context', async (t) => {
  const { client, recorded } = makeTestClient();
  const ctx = activityCtx('wf1', 'act1');

  await client.activity.fail(TASK_TOKEN, ApplicationFailure.nonRetryable('boom', 'Error', makeContextTrace('detail')), {
    serializationContext: activitySerializationContext(client.options.namespace, 'wf1', 'act1'),
  });

  t.is(recorded.respondActivityTaskFailed.length, 1);
  const request = recorded.respondActivityTaskFailed[0]!;
  expectEncodedWith(t, request.failure.applicationFailureInfo?.details?.payloads, 'detail', ctx);
  t.is(request.failure.message, `failure.encode.bound|${ctx}|boom`);
});

test('AsyncCompletionClient reportCancellation by full ID infers activity context', async (t) => {
  const { client, recorded } = makeTestClient();
  const ctx = activityCtx('wf1', 'act1');

  await client.activity.reportCancellation({ workflowId: 'wf1', activityId: 'act1' }, makeContextTrace('details'));

  t.is(recorded.respondActivityTaskCanceledById.length, 1);
  const request = recorded.respondActivityTaskCanceledById[0]!;
  expectEncodedWith(t, request.details?.payloads, 'details', ctx);
});

test('AsyncCompletionClient reportCancellation with task token uses explicit activity context', async (t) => {
  const { client, recorded } = makeTestClient();
  const ctx = activityCtx('wf1', 'act1');

  await client.activity.reportCancellation(TASK_TOKEN, makeContextTrace('details'), {
    serializationContext: activitySerializationContext(client.options.namespace, 'wf1', 'act1'),
  });

  t.is(recorded.respondActivityTaskCanceled.length, 1);
  const request = recorded.respondActivityTaskCanceled[0]!;
  expectEncodedWith(t, request.details?.payloads, 'details', ctx);
});

test('AsyncCompletionClient heartbeat by full ID infers activity context', async (t) => {
  const { client, recorded } = makeTestClient();
  const ctx = activityCtx('wf1', 'act1');

  await client.activity.heartbeat({ workflowId: 'wf1', activityId: 'act1' }, makeContextTrace('details'));

  t.is(recorded.recordActivityTaskHeartbeatById.length, 1);
  const request = recorded.recordActivityTaskHeartbeatById[0]!;
  expectEncodedWith(t, request.details?.payloads, 'details', ctx);
});

test('AsyncCompletionClient heartbeat with task token uses explicit activity context', async (t) => {
  const { client, recorded } = makeTestClient();
  const ctx = activityCtx('wf1', 'act1');

  await client.activity.heartbeat(TASK_TOKEN, makeContextTrace('details'), {
    serializationContext: activitySerializationContext(client.options.namespace, 'wf1', 'act1'),
  });

  t.is(recorded.recordActivityTaskHeartbeat.length, 1);
  const request = recorded.recordActivityTaskHeartbeat[0]!;
  expectEncodedWith(t, request.details?.payloads, 'details', ctx);
});

if (RUN_INTEGRATION_TESTS) {
  test.before(async (t) => {
    const infoSubject = new Subject<Info>();

    const worker = await Worker.create({
      workflowsPath: require.resolve('./workflows'),
      activities: createActivities(infoSubject),
      taskQueue,
    });
    const runPromise = worker.run();
    // Catch the error here to avoid unhandled rejection
    runPromise.catch((err) => {
      console.error('Caught error while worker was running', err);
    });
    const connection = await Connection.connect();
    t.context = {
      worker,
      runPromise,
      activityStarted$: infoSubject,
      client: new Client({ connection }),
      notFoundTaskToken: await makeNotFoundTaskToken(connection, 'default'),
    };
  });

  test.after.always(async (t) => {
    t.context.worker.shutdown();
    await t.context.runPromise;
  });

  test('Activity can complete asynchronously', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handle = await client.workflow.start(runAnAsyncActivity, {
      workflowId,
      taskQueue,
    });

    const info = await activityStarted(t, workflowId);
    await client.activity.complete(info.taskToken, 'success');
    t.is(await handle.result(), 'success');
  });

  test('Activity can complete asynchronously by ID', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handle = await client.workflow.start(runAnAsyncActivity, {
      workflowId,
      taskQueue,
    });

    const info = await activityStarted(t, workflowId);
    await client.activity.complete({ workflowId, activityId: info.activityId }, 'success');
    t.is(await handle.result(), 'success');
  });

  test('Non existing activity async completion throws meaningful message', async (t) => {
    await t.throwsAsync(t.context.client.activity.complete(t.context.notFoundTaskToken, 'success'), {
      instanceOf: ActivityNotFoundError,
    });
  });

  test('Non existing activity async completion by ID throws meaningful message', async (t) => {
    await t.throwsAsync(t.context.client.activity.complete({ workflowId: uuid4(), activityId: '1' }, 'success'), {
      instanceOf: ActivityNotFoundError,
    });
  });

  test('Activity can fail asynchronously', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handle = await client.workflow.start(runAnAsyncActivity, {
      workflowId,
      taskQueue,
    });

    const info = await activityStarted(t, workflowId);
    await client.activity.fail(info.taskToken, new Error('failed'));
    const err = (await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    })) as WorkflowFailedError;
    t.is(rootCause(err.cause), 'failed');
  });

  test('Activity can fail asynchronously by ID', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handle = await client.workflow.start(runAnAsyncActivity, {
      workflowId,
      taskQueue,
    });

    const info = await activityStarted(t, workflowId);
    await client.activity.fail({ workflowId, activityId: info.activityId }, new Error('failed'));
    const err = (await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    })) as WorkflowFailedError;
    t.is(rootCause(err.cause), 'failed');
  });

  test('Non existing activity async failure throws meaningful message', async (t) => {
    await t.throwsAsync(t.context.client.activity.fail(t.context.notFoundTaskToken, new Error('failure')), {
      instanceOf: ActivityNotFoundError,
    });
  });

  test('Non existing activity async failure by ID throws meaningful message', async (t) => {
    await t.throwsAsync(
      t.context.client.activity.fail(
        {
          workflowId: uuid4(),
          activityId: '1',
        },
        new Error('failure')
      ),
      {
        instanceOf: ActivityNotFoundError,
      }
    );
  });

  test('Non existing activity async cancellation throws meaningful message', async (t) => {
    await t.throwsAsync(t.context.client.activity.reportCancellation(t.context.notFoundTaskToken, 'cancelled'), {
      instanceOf: ActivityNotFoundError,
    });
  });

  test('Non existing activity async cancellation by ID throws meaningful message', async (t) => {
    await t.throwsAsync(
      t.context.client.activity.reportCancellation(
        {
          workflowId: uuid4(),
          activityId: '1',
        },
        'cancelled'
      ),
      {
        instanceOf: ActivityNotFoundError,
      }
    );
  });

  test('Activity can heartbeat and get cancelled with AsyncCompletionClient', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handle = await client.workflow.start(runAnAsyncActivity, {
      workflowId,
      taskQueue,
      args: [true],
    });

    const info = await activityStarted(t, workflowId);
    await t.throwsAsync(
      async () => {
        for (;;) {
          await client.activity.heartbeat(info.taskToken, 'details');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
      { instanceOf: ActivityCancelledError }
    );

    await client.activity.reportCancellation(info.taskToken, 'cancelled');

    const err = (await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    })) as WorkflowFailedError;
    t.true(isCancellation(err.cause));
  });

  test('Activity can heartbeat and get cancelled by ID with AsyncCompletionClient', async (t) => {
    const { client } = t.context;
    const workflowId = uuid4();
    const handle = await client.workflow.start(runAnAsyncActivity, {
      workflowId,
      taskQueue,
      args: [true],
    });

    const info = await activityStarted(t, workflowId);
    await t.throwsAsync(
      async () => {
        for (;;) {
          await client.activity.heartbeat({ workflowId, activityId: info.activityId }, 'details');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
      { instanceOf: ActivityCancelledError }
    );

    await client.activity.reportCancellation({ workflowId, activityId: info.activityId }, 'cancelled');

    const err = (await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    })) as WorkflowFailedError;
    t.true(isCancellation(err.cause));
  });

  test('Non existing activity async heartbeat throws meaningful message', async (t) => {
    await t.throwsAsync(t.context.client.activity.heartbeat(t.context.notFoundTaskToken, 'details'), {
      instanceOf: ActivityNotFoundError,
    });
  });

  test('Non existing activity async heartbeat by ID throws meaningful message', async (t) => {
    await t.throwsAsync(
      t.context.client.activity.heartbeat(
        {
          workflowId: uuid4(),
          activityId: '1',
        },
        'details'
      ),
      {
        instanceOf: ActivityNotFoundError,
      }
    );
  });

  test('Standalone activity can complete asynchronously', async (t) => {
    const { client } = t.context;
    const activityId = uuid4();
    const handle = await client.activity.start('completeAsync', {
      args: [false],
      id: activityId,
      taskQueue,
      scheduleToCloseTimeout: '1 minute',
      retry: {
        maximumAttempts: 1,
      },
    });

    const info = await activityStarted(t, activityId);
    await client.activity.complete(info.taskToken, 'success');
    t.is(await handle.result(), 'success');
  });

  test('Standalone activity can complete asynchronously by ID', async (t) => {
    const { client } = t.context;
    const activityId = uuid4();
    const handle = await client.activity.start('completeAsync', {
      args: [false],
      id: activityId,
      taskQueue,
      scheduleToCloseTimeout: '1 minutes',
      retry: {
        maximumAttempts: 1,
      },
    });

    const info = await activityStarted(t, activityId);
    await client.activity.complete({ activityId, runId: info.activityRunId }, 'success');
    t.is(await handle.result(), 'success');
  });
}
