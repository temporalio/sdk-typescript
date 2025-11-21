import { randomUUID } from 'crypto';
import {
  DefaultFailureConverter,
  ApplicationFailure,
  DataConverter,
  DefaultEncodedFailureAttributes,
  TemporalFailure,
} from '@temporalio/common';
import { proxyActivities } from '@temporalio/workflow';
import { WorkflowFailedError } from '@temporalio/client';
import { decodeFromPayloadsAtIndex } from '@temporalio/common/lib/internal-non-workflow';
import { test, bundlerOptions, ByteSkewerPayloadCodec, Worker, TestWorkflowEnvironment } from './helpers';

export const failureConverter = new DefaultFailureConverter({ encodeCommonAttributes: true });

class Activities {
  public raise = async () => {
    throw ApplicationFailure.nonRetryable('error message');
  };
}

export async function workflow(): Promise<void> {
  const activities = proxyActivities<Activities>({ startToCloseTimeout: '1m' });
  await activities.raise();
}

test('Client and Worker use provided failureConverter', async (t) => {
  const dataConverter: DataConverter = {
    // Use a payload codec to verify that it's being utilized to encode / decode the failure
    payloadCodecs: [new ByteSkewerPayloadCodec()],
    failureConverterPath: __filename,
  };
  const env = await TestWorkflowEnvironment.createLocal({ client: { dataConverter } });
  try {
    const taskQueue = 'test';
    const worker = await Worker.create({
      connection: env.nativeConnection,
      activities: new Activities(),
      workflowsPath: __filename,
      taskQueue,
      dataConverter,
      bundlerOptions,
    });

    // Run the workflow, expect error with message and stack trace
    const handle = await env.client.workflow.start(workflow, { taskQueue, workflowId: randomUUID() });
    const err = (await worker.runUntil(t.throwsAsync(handle.result()))) as WorkflowFailedError;
    t.is(err.cause?.message, 'Activity task failed');
    if (!(err.cause instanceof TemporalFailure)) {
      t.fail('expected error cause to be a TemporalFailure');
      return;
    }
    t.is(err.cause?.cause?.message, 'error message');
    t.true(err.cause?.cause?.stack?.includes('ApplicationFailure: error message\n'));

    // Verify failure was indeed encoded
    const { events } = await handle.fetchHistory();
    const { failure } = events?.[events.length - 1].workflowExecutionFailedEventAttributes ?? {};
    {
      const payload = failure?.encodedAttributes;
      const attrs = await decodeFromPayloadsAtIndex<DefaultEncodedFailureAttributes>(
        env.client.options.loadedDataConverter,
        0,
        payload ? [payload] : undefined
      );
      t.is(failure?.message, 'Encoded failure');
      t.is(failure?.stackTrace, '');
      t.is(attrs.message, 'Activity task failed');
      t.is(attrs.stack_trace, '');
    }
    {
      const payload = failure?.cause?.encodedAttributes;
      const attrs = await decodeFromPayloadsAtIndex<DefaultEncodedFailureAttributes>(
        env.client.options.loadedDataConverter,
        0,
        payload ? [payload] : undefined
      );
      t.is(failure?.cause?.message, 'Encoded failure');
      t.is(failure?.stackTrace, '');
      t.is(attrs.message, 'error message');
      t.true(attrs.stack_trace.includes('ApplicationFailure: error message\n'));
    }
  } finally {
    await env.teardown();
  }
});
