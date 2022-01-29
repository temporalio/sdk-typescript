import { Connection, WorkflowClient } from '@temporalio/client';
import { coresdk } from '@temporalio/proto';
import { Worker } from '@temporalio/worker';
import test, { ExecutionContext } from 'ava';
import { v4 as uuid4 } from 'uuid';
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
  actual: coresdk.activity_result.IActivityExecutionResult | null | undefined,
  expected: coresdk.activity_result.IActivityExecutionResult
) {
  if (actual?.failed?.failure) {
    const { stackTrace, ...rest } = actual.failed.failure;
    actual = { failed: { failure: { stackTrace: cleanStackTrace(stackTrace), ...rest } } };
  }
  t.deepEqual(
    new coresdk.activity_result.ActivityExecutionResult(actual ?? undefined).toJSON(),
    new coresdk.activity_result.ActivityExecutionResult(expected).toJSON()
  );
}

if (RUN_INTEGRATION_TESTS) {
  test('Client and Worker work with provided dataConverter/dataConverterPath', async (t) => {
    const taskQueue = 'test-custom-data-converter';
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      dataConverterPath: require.resolve('./data-converters/data-converter'),
    });
    const connection = new Connection();
    const client = new WorkflowClient(connection.service, { dataConverter });
    const runAndShutdown = async () => {
      const result = await client.execute(protobufWorkflow, {
        args: [messageInstance],
        workflowId: uuid4(),
        taskQueue,
      });
      t.deepEqual(result, messageInstance);
      worker.shutdown();
    };
    await Promise.all([worker.run(), runAndShutdown()]);
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

  await runWorker(worker, async () => {
    const taskToken = Buffer.from(uuid4());
    const completion = await worker.native.runActivityTask({
      taskToken,
      start: {
        activityType: 'protoActivity',
        input: await dataConverter.toPayloads(messageInstance),
      },
    });
    compareCompletion(t, completion.result, {
      completed: { result: await dataConverter.toPayload(await protoActivity(messageInstance)) },
    });
  });
});
