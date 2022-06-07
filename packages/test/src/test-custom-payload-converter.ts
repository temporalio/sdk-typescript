import { WorkflowClient } from '@temporalio/client';
import { toPayloads } from '@temporalio/common';
import { coresdk } from '@temporalio/proto';
import { Worker } from '@temporalio/worker';
import test, { ExecutionContext } from 'ava';
import { v4 as uuid4 } from 'uuid';
import { ProtoActivityResult } from '../protos/root';
import { protoActivity } from './activities';
import { cleanStackTrace, RUN_INTEGRATION_TESTS } from './helpers';
import { defaultOptions, isolateFreeWorker } from './mock-native-worker';
import { messageInstance, payloadConverter } from './payload-converters/proto-payload-converter';
import * as workflows from './workflows';
import { protobufWorkflow } from './workflows/protobufs';

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
    const dataConverter = { payloadConverterPath: require.resolve('./payload-converters/proto-payload-converter') };
    const taskQueue = 'test-custom-payload-converter';
    const worker = await Worker.create({
      ...defaultOptions,
      workflowsPath: require.resolve('./workflows/protobufs'),
      taskQueue,
      dataConverter,
    });
    const client = new WorkflowClient({ dataConverter });
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

  test('fromPayload throws on Client when receiving result from client.execute()', async (t) => {
    const worker = await Worker.create({
      ...defaultOptions,
    });

    const runPromise = worker.run();

    const client = new WorkflowClient({
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
  t.throws(
    () =>
      isolateFreeWorker({
        ...defaultOptions,
        dataConverter: { payloadConverterPath: './wrong-path' },
      }),
    {
      message: /Could not find a file at the specified payloadConverterPath/,
    }
  );

  t.throws(
    () =>
      isolateFreeWorker({
        ...defaultOptions,
        dataConverter: { payloadConverterPath: require.resolve('./payload-converters/payload-converter-no-export') },
      }),
    {
      message: /Module .* does not have a `payloadConverter` named export/,
    }
  );

  t.throws(
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
  const worker = isolateFreeWorker({
    ...defaultOptions,
    dataConverter: { payloadConverterPath: require.resolve('./payload-converters/proto-payload-converter') },
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
