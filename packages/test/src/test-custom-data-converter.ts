import { Connection, WorkflowClient } from '@temporalio/client';
import { coresdk } from '@temporalio/proto';
import { Core, DefaultLogger, Worker } from '@temporalio/worker';
import test, { ExecutionContext } from 'ava';
import { v4 as uuid4 } from 'uuid';
import { ProtoActivityInput } from '../protos/protobufs';
import { protoActivity } from './activities';
import { dataConverter, messageInstance } from './data-converters/data-converter';
import { cleanStackTrace, RUN_INTEGRATION_TESTS } from './helpers';
import { defaultOptions, isolateFreeWorker } from './mock-native-worker';
import { protobufWorkflow } from './workflows';

export async function runWorker(worker: Worker, fn: () => Promise<any>): Promise<void> {
  const promise = worker.run();
  await fn();
  worker.shutdown();
  await promise;
}

function compareCompletion(
  t: ExecutionContext,
  actual: coresdk.activity_result.IActivityResult | null | undefined,
  expected: coresdk.activity_result.IActivityResult
) {
  if (actual?.failed?.failure) {
    const { stackTrace, ...rest } = actual.failed.failure;
    actual = { failed: { failure: { stackTrace: cleanStackTrace(stackTrace), ...rest } } };
  }
  t.deepEqual(
    new coresdk.activity_result.ActivityResult(actual ?? undefined).toJSON(),
    new coresdk.activity_result.ActivityResult(expected).toJSON()
  );
}

if (RUN_INTEGRATION_TESTS) {
  test('Client and Worker work with provided dataConverter/dataConverterPath', async (t) => {
    let resolvePromise: (value: unknown) => void;
    const receivedExpectedError = new Promise(function (resolve) {
      resolvePromise = resolve;
    });

    await Core.install({
      logger: new DefaultLogger('ERROR', (entry) => {
        if (
          entry.message === 'Failed to activate workflow' &&
          entry.meta?.error?.stack?.includes('Activator.startWorkflow') &&
          entry.meta?.error?.message ===
            'Unable to deserialize protobuf message without protobufClasses provided to DefaultDataConverter'
        ) {
          resolvePromise(true);
        }
      }),
    });

    const taskQueue = 'custom-data-converter';
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      dataConverterPath: require.resolve('./data-converters/data-converter'),
    });
    const connection = new Connection();
    const client = new WorkflowClient(connection.service, { dataConverter });

    // For now, just check that the protobuf message gets to the workflow
    worker.run();
    client.execute(protobufWorkflow, {
      args: [messageInstance],
      workflowId: uuid4(),
      taskQueue,
    });
    await receivedExpectedError;
    worker.shutdown();
    t.pass();

    // const runAndShutdown = async () => {
    //   const result = await client.execute(protobufWorkflow, {
    //     args: [messageInstance],
    //     workflowId: uuid4(),
    //     taskQueue,
    //   });
    //   t.is(result, messageInstance);
    //   worker.shutdown();
    // };
    // await Promise.all([worker.run(), runAndShutdown()]);
  });
}

test('Worker throws on invalid dataConverterPath', async (t) => {
  await t.throwsAsync(
    isolateFreeWorker({
      ...defaultOptions,
      dataConverterPath: './wrong-path',
    }),
    {
      message: /Could not find a file at the specified dataConverterPath/,
    }
  );

  await t.throwsAsync(
    isolateFreeWorker({
      ...defaultOptions,
      dataConverterPath: require.resolve('./data-converters/data-converter-no-export'),
    }),
    {
      message: /The module at dataConverterPath .* does not have a `dataConverter` named export./,
    }
  );

  await t.throwsAsync(
    isolateFreeWorker({
      ...defaultOptions,
      dataConverterPath: require.resolve('./data-converters/data-converter-bad-export'),
    }),
    {
      message:
        /The `dataConverter` named export at dataConverterPath .* should be an instance of a class that implements the DataConverter interface./,
    }
  );
});

test('Worker with proto data converter runs an activity and reports completion', async (t) => {
  const worker = await isolateFreeWorker({
    ...defaultOptions,
    dataConverterPath: require.resolve('./data-converters/data-converter'),
  });

  const input = new ProtoActivityInput({ name: 'Proto', age: 1 });

  await runWorker(worker, async () => {
    const taskToken = Buffer.from(uuid4());
    const completion = await worker.native.runActivityTask({
      taskToken,
      activityId: 'abc',
      start: {
        activityType: 'protoActivity',
        input: await dataConverter.toPayloads(input),
      },
    });
    compareCompletion(t, completion.result, {
      completed: { result: await dataConverter.toPayload(await protoActivity(input)) },
    });
  });
});
