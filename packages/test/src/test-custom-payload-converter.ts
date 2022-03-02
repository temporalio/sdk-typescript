import { Connection, WorkflowClient } from '@temporalio/client';
import { toPayloads } from '@temporalio/common';
import { coresdk } from '@temporalio/proto';
import { Worker } from '@temporalio/worker';
import test, { ExecutionContext } from 'ava';
import { v4 as uuid4 } from 'uuid';
import { ProtoActivityResult } from '../protos/root';
import { protoActivity } from './activities';
import { cleanStackTrace, RUN_INTEGRATION_TESTS } from './helpers';
import { defaultOptions, isolateFreeWorker } from './mock-native-worker';
import { messageInstance, payloadConverter } from './payload-converters/payload-converter';
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
