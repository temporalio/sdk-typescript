import type { ExecutionContext } from 'ava';
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { WorkflowClient } from '@temporalio/client';
import { toPayloads } from '@temporalio/common';
import { coresdk } from '@temporalio/proto';
import { ProtoActivityResult } from '../protos/root';
import { protoActivity } from './activities';
import { cleanOptionalStackTrace, RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { defaultOptions, isolateFreeWorker } from './mock-native-worker';
import { messageInstance, payloadConverter } from './payload-converters/proto-payload-converter';
import * as workflows from './workflows';
import { protobufWorkflow } from './workflows/protobufs';

function compareCompletion(
  t: ExecutionContext,
  actual: coresdk.activity_result.IActivityExecutionResult | null | undefined,
  expected: coresdk.activity_result.IActivityExecutionResult
) {
  if (actual?.failed?.failure) {
    const { stackTrace, ...rest } = actual.failed.failure;
    actual = { failed: { failure: { stackTrace: cleanOptionalStackTrace(stackTrace), ...rest } } };
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
    await worker.runUntil(async () => {
      const result = await client.execute(protobufWorkflow, {
        args: [messageInstance],
        workflowId: uuid4(),
        taskQueue,
      });

      t.deepEqual(result, ProtoActivityResult.create({ sentence: `Proto is 1 years old.` }));
    });
  });

  test('fromPayload throws on Client when receiving result from client.execute()', async (t) => {
    const worker = await Worker.create({
      ...defaultOptions,
    });

    const client = new WorkflowClient({
      dataConverter: {
        payloadConverterPath: require.resolve('./payload-converters/payload-converter-throws-from-payload'),
      },
    });
    await worker.runUntil(
      t.throwsAsync(
        client.execute(workflows.successString, {
          taskQueue: 'test',
          workflowId: uuid4(),
        }),
        {
          instanceOf: Error,
          message: 'test fromPayload',
        }
      )
    );
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

  t.throws(
    () =>
      isolateFreeWorker({
        ...defaultOptions,
        dataConverter: { failureConverterPath: require.resolve('./payload-converters/payload-converter-bad-export') },
      }),
    {
      message: /Module .* does not have a `failureConverter` named export/,
    }
  );

  t.throws(
    () =>
      isolateFreeWorker({
        ...defaultOptions,
        dataConverter: { failureConverterPath: require.resolve('./payload-converters/failure-converter-bad-export') },
      }),
    {
      message: /failureConverter export at .* must be an object with errorToFailure and failureToError methods/,
    }
  );
});

test('Worker with proto data converter runs an activity and reports completion', async (t) => {
  const worker = isolateFreeWorker({
    ...defaultOptions,
    dataConverter: { payloadConverterPath: require.resolve('./payload-converters/proto-payload-converter') },
  });

  await worker.runUntil(async () => {
    const taskToken = Buffer.from(uuid4());
    const completion = await worker.native.runActivityTask({
      taskToken,
      start: {
        activityType: 'protoActivity',
        workflowExecution: { workflowId: 'wfid', runId: 'runId' },
        input: toPayloads(payloadConverter, messageInstance),
      },
    });
    compareCompletion(t, completion.result, {
      completed: { result: payloadConverter.toPayload(await protoActivity(messageInstance)) },
    });
  });
});
