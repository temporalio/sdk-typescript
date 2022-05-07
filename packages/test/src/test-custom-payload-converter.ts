import { Connection, WorkflowClient } from '@temporalio/client';
import { toPayloads, ValueError } from '@temporalio/common';
import { coresdk } from '@temporalio/proto';
import { InjectedSinks, Worker } from '@temporalio/worker';
import asyncRetry from 'async-retry';
import test, { ExecutionContext } from 'ava';
import { v4 as uuid4 } from 'uuid';
import { ProtoActivityResult } from '../protos/root';
import { protoActivity } from './activities';
import { cleanStackTrace, RUN_INTEGRATION_TESTS } from './helpers';
import { defaultOptions, isolateFreeWorker } from './mock-native-worker';
import { messageInstance, payloadConverter } from './payload-converters/payload-converter';
import * as workflows from './workflows';
import { LogSinks, protobufWorkflow } from './workflows';

export async function runWorker(worker: Worker, fn: () => Promise<any>): Promise<void> {
  const promise = worker.run();
  await fn();
  worker.shutdown();
  await promise;
}

function compareCompletion(
  t: ExecutionContext,
  actual: coresdk.activity_result.IActivityExecutionResult | null | undefined,
  expected: coresdk.activity_result.IActivityExecutionResult
) {
  if (actual?.failed?.failure) {
    const { stackTrace, ...rest } = actual.failed.failure;
    actual = { failed: { failure: { stackTrace: cleanStackTrace(stackTrace), ...rest } } };
  }
  t.deepEqual(
    coresdk.activity_result.ActivityExecutionResult.create(actual ?? undefined).toJSON(),
    coresdk.activity_result.ActivityExecutionResult.create(expected).toJSON()
  );
}

if (RUN_INTEGRATION_TESTS) {
  test('Client and Worker work with provided dataConverter', async (t) => {
    const dataConverter = { payloadConverterPath: require.resolve('./payload-converters/payload-converter') };
    const taskQueue = 'test-custom-payload-converter';
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      dataConverter,
    });
    const connection = new Connection();
    const client = new WorkflowClient(connection.service, { dataConverter });
    const runAndShutdown = async () => {
      const result = await client.execute(protobufWorkflow, {
        args: [messageInstance],
        workflowId: uuid4(),
        taskQueue,
      });

      t.deepEqual(result, ProtoActivityResult.create({ sentence: `Proto is 1 years old.` }));
      worker.shutdown();
    };
    await Promise.all([worker.run(), runAndShutdown()]);
  });

  // use default dataConverter for Client
  // use payload-converter-returns-undefined for Worker
  // Workflow should throw when running toPayload on "success" retval
  test('toPayload throwing results in task retry', async (t) => {
    const taskQueue = 'toPayload throwing results in task retry';
    console.log('taskQueue:', taskQueue);
    const client = new WorkflowClient();
    const handle = await client.start(workflows.successString, {
      taskQueue,
      workflowId: uuid4(),
    });

    const logs: string[] = [];
    const sinks: InjectedSinks<LogSinks> = {
      logger: {
        log: {
          fn(_, message) {
            logs.push(message);
          },
        },
      },
    };

    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      sinks,
      dataConverter: {
        payloadConverterPath: require.resolve('./payload-converters/payload-converter-returns-undefined'),
      },
    });

    const runPromise = worker.run();
    runPromise.catch((err: any) => {
      console.error('Caught error while worker was running', err);
    });

    try {
      await asyncRetry(
        async () => {
          const { history } = await client.service.getWorkflowExecutionHistory({
            namespace: 'default',
            execution: { workflowId: handle.workflowId },
          });
          if (
            !history?.events?.some(
              ({ workflowTaskFailedEventAttributes }) =>
                workflowTaskFailedEventAttributes?.failure?.message ===
                'The Payload Converter method TestPayloadConverter.toPayload must return a Payload. Received `undefined` of type `undefined` when trying to convert `success` of type `string`.'
            )
          ) {
            throw new Error('Cannot find workflow task failed event');
          }
        },
        {
          retries: 60,
          maxTimeout: 1000,
        }
      );
    } finally {
      await handle.terminate();
    }
    t.pass();

    worker.shutdown();
    await runPromise;
  });

  test('toPayload throws from client.start', async (t) => {
    const connection = new Connection();
    const client = new WorkflowClient(connection.service, {
      dataConverter: {
        payloadConverterPath: require.resolve('./payload-converters/payload-converter-returns-undefined'),
      },
    });
    await t.throwsAsync(
      client.start(workflows.twoStrings, {
        taskQueue: 'test',
        workflowId: uuid4(),
        args: ['hello', 'world'],
      }),
      {
        instanceOf: ValueError,
        message:
          'The Payload Converter method TestPayloadConverter.toPayload must return a Payload. Received `undefined` of type `undefined` when trying to convert `hello` of type `string`.',
      }
    );
  });

  test('fromPayload throws from client.execute', async (t) => {
    const worker = await Worker.create({
      ...defaultOptions,
    });

    const runPromise = worker.run();

    const connection = new Connection();
    const client = new WorkflowClient(connection.service, {
      dataConverter: {
        payloadConverterPath: require.resolve('./payload-converters/payload-converter-throws-from-payload'),
      },
    });
    await t.throwsAsync(
      client.execute(workflows.successString, {
        taskQueue: 'test',
        workflowId: uuid4(),
      }),
      {
        instanceOf: Error,
        message: 'test fromPayload',
      }
    );

    worker.shutdown();
    await runPromise;
  });
}

test('Worker throws on invalid payloadConverterPath', async (t) => {
  await t.throws(
    () =>
      isolateFreeWorker({
        ...defaultOptions,
        dataConverter: { payloadConverterPath: './wrong-path' },
      }),
    {
      message: /Could not find a file at the specified payloadConverterPath/,
    }
  );

  await t.throws(
    () =>
      isolateFreeWorker({
        ...defaultOptions,
        dataConverter: { payloadConverterPath: require.resolve('./payload-converters/payload-converter-no-export') },
      }),
    {
      message: /Module .* does not have a `payloadConverter` named export/,
    }
  );

  await t.throws(
    () =>
      isolateFreeWorker({
        ...defaultOptions,
        dataConverter: { payloadConverterPath: require.resolve('./payload-converters/payload-converter-bad-export') },
      }),
    {
      message: /payloadConverter export at .* must be an object with toPayload and fromPayload methods/,
    }
  );
});

test('Worker with proto data converter runs an activity and reports completion', async (t) => {
  const worker = await isolateFreeWorker({
    ...defaultOptions,
    dataConverter: { payloadConverterPath: require.resolve('./payload-converters/payload-converter') },
  });

  await runWorker(worker, async () => {
    const taskToken = Buffer.from(uuid4());
    const completion = await worker.native.runActivityTask({
      taskToken,
      start: {
        activityType: 'protoActivity',
        input: toPayloads(payloadConverter, messageInstance),
      },
    });
    compareCompletion(t, completion.result, {
      completed: { result: payloadConverter.toPayload(await protoActivity(messageInstance)) },
    });
  });
});

test('Custom payload converter that returns undefined results in thrown Error', async (t) => {
  const worker = await isolateFreeWorker({
    ...defaultOptions,
    dataConverter: {
      payloadConverterPath: require.resolve('./payload-converters/payload-converter-returns-undefined'),
    },
  });
  await runWorker(worker, async () => {
    const taskToken = Buffer.from(uuid4());
    const completion = await worker.native.runActivityTask({
      taskToken,
      start: {
        activityType: 'echo',
        input: toPayloads(payloadConverter, 'message'),
      },
    });
    t.is(
      completion.result?.failed?.failure?.message,
      'The Payload Converter method TestPayloadConverter.toPayload must return a Payload. Received `undefined` of type `undefined` when trying to convert `message` of type `string`.'
    );
    // is retryable
    t.false(completion.result?.failed?.failure?.applicationFailureInfo?.nonRetryable);
  });
});
