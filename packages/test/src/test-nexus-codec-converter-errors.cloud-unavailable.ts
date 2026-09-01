import { randomUUID } from 'crypto';
import * as nexus from 'nexus-rpc';
import type { Payload } from '@temporalio/common';
import {
  ApplicationFailure,
  createPayloadValidationError,
  defaultFailureConverter,
  defaultPayloadConverter,
  NexusOperationFailure,
} from '@temporalio/common';
import { Client, WorkflowFailedError } from '@temporalio/client';
import type { PayloadCodec } from '@temporalio/common/lib/converter/payload-codec';
import { temporal } from '@temporalio/proto';
import * as workflow from '@temporalio/workflow';
import { waitUntil } from './helpers';
import { createTestWorkflowBundle, helpers, makeTestFunction } from './helpers-integration';
import { innermostHandlerError } from './helpers-nexus';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
});

const testService = nexus.service('codec-converter-test', {
  echoOp: nexus.operation<string, string>(),
});

export async function nexusEchoCaller(endpoint: string, input: any = 'hello'): Promise<any> {
  const client = workflow.createNexusServiceClient({
    endpoint,
    service: testService,
  });
  const handle = await client.startOperation('echoOp', input);
  return await handle.result();
}

export async function nexusOutputCaller(endpoint: string): Promise<string> {
  await nexusEchoCaller(endpoint);
  return 'done';
}

export async function nexusValidationOutputRetryCaller(endpoint: string): Promise<{ nexusResult: string }> {
  const client = workflow.createNexusServiceClient({
    endpoint,
    service: testService,
  });
  const handle = await client.startOperation('echoOp', 'hello');
  return { nexusResult: await handle.result() };
}

////////////////////////////////////////////////////////////////////////////////////////////////////

test('Nexus operation codec failure is retried', async (t) => {
  const { createWorker, registerNexusEndpoint, taskQueue } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  let decodeCount = 0;
  const failingCodec: PayloadCodec = {
    async encode(payloads: Payload[]): Promise<Payload[]> {
      return payloads;
    },
    async decode(payloads: Payload[]): Promise<Payload[]> {
      decodeCount++;
      if (decodeCount === 1) {
        throw new Error('Intentional codec decode failure');
      }
      return payloads;
    },
  };

  const worker = await createWorker({
    dataConverter: { payloadCodecs: [failingCodec] },
    nexusServices: [
      nexus.serviceHandler(testService, {
        async echoOp(_ctx, input) {
          return input;
        },
      }),
    ],
  });

  const customClient = new Client({
    connection: t.context.env.connection,
    dataConverter: { payloadCodecs: [failingCodec] },
  });

  await worker.runUntil(async () => {
    const result = await customClient.workflow.execute(nexusEchoCaller, {
      taskQueue,
      workflowId: randomUUID(),
      args: [endpointName],
    });
    t.is(result, 'hello');
  });

  t.true(decodeCount >= 2, `Expected decode count >= 2, got ${decodeCount}`);
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test('Nexus operation converter failure is not retried', async (t) => {
  const { createWorker, registerNexusEndpoint, taskQueue } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    dataConverter: { payloadConverterPath: require.resolve('./failing-payload-converter') },
    nexusServices: [
      nexus.serviceHandler(testService, {
        async echoOp(_ctx, input) {
          return input;
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const err = await t.throwsAsync(
      () =>
        t.context.env.client.workflow.execute(nexusEchoCaller, {
          taskQueue,
          workflowId: randomUUID(),
          args: [endpointName],
        }),
      {
        instanceOf: WorkflowFailedError,
      }
    );
    t.true(err instanceof WorkflowFailedError);
    t.true(err!.cause instanceof NexusOperationFailure);
    const nexusFailure = err!.cause as NexusOperationFailure;
    t.true(nexusFailure.cause instanceof nexus.HandlerError);
    const outerHandler = nexusFailure.cause as nexus.HandlerError;
    t.is(outerHandler.type, 'BAD_REQUEST');
    t.false(outerHandler.retryable);
    const handlerError = innermostHandlerError(outerHandler);
    t.regex(handlerError.message, /Payload converter failed to decode Nexus operation input/);
    const converterError = handlerError.cause as Error;
    t.regex(converterError.message, /Intentional payload converter failure for testing/);
  });
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test('Nexus operation codec HandlerError is propagated as-is', async (t) => {
  const { createWorker, registerNexusEndpoint, taskQueue } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  // Only fail when decoding the Nexus operation input ('hello'), so that the caller workflow's
  // own activation payloads still decode successfully and the operation is actually reached.
  const handlerErrorCodec: PayloadCodec = {
    async encode(payloads: Payload[]): Promise<Payload[]> {
      return payloads;
    },
    async decode(payloads: Payload[]): Promise<Payload[]> {
      for (const payload of payloads) {
        if (payload.data != null && Buffer.from(payload.data).toString() === '"hello"') {
          throw new nexus.HandlerError('NOT_FOUND', 'Intentional codec HandlerError for testing', {
            retryableOverride: false,
          });
        }
      }
      return payloads;
    },
  };

  const worker = await createWorker({
    dataConverter: { payloadCodecs: [handlerErrorCodec] },
    nexusServices: [
      nexus.serviceHandler(testService, {
        async echoOp(_ctx, input) {
          return input;
        },
      }),
    ],
  });

  const customClient = new Client({
    connection: t.context.env.connection,
    dataConverter: { payloadCodecs: [handlerErrorCodec] },
  });

  await worker.runUntil(async () => {
    const err = await t.throwsAsync(
      () =>
        customClient.workflow.execute(nexusEchoCaller, {
          taskQueue,
          workflowId: randomUUID(),
          args: [endpointName],
        }),
      {
        instanceOf: WorkflowFailedError,
      }
    );
    t.true(err!.cause instanceof NexusOperationFailure);
    const nexusFailure = err!.cause as NexusOperationFailure;
    t.true(nexusFailure.cause instanceof nexus.HandlerError);
    const handlerError = innermostHandlerError(nexusFailure.cause as nexus.HandlerError);
    t.is(handlerError.type, 'NOT_FOUND');
    t.false(handlerError.retryable);
    t.regex(handlerError.message, /Intentional codec HandlerError for testing/);
  });
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test('Nexus operation converter HandlerError is propagated as-is', async (t) => {
  const { createWorker, registerNexusEndpoint, taskQueue } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    dataConverter: { payloadConverterPath: require.resolve('./failing-handler-error-payload-converter') },
    nexusServices: [
      nexus.serviceHandler(testService, {
        async echoOp(_ctx, input) {
          return input;
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const err = await t.throwsAsync(
      () =>
        t.context.env.client.workflow.execute(nexusEchoCaller, {
          taskQueue,
          workflowId: randomUUID(),
          args: [endpointName],
        }),
      {
        instanceOf: WorkflowFailedError,
      }
    );
    t.true(err!.cause instanceof NexusOperationFailure);
    const nexusFailure = err!.cause as NexusOperationFailure;
    t.true(nexusFailure.cause instanceof nexus.HandlerError);
    const handlerError = innermostHandlerError(nexusFailure.cause as nexus.HandlerError);
    t.is(handlerError.type, 'NOT_FOUND');
    t.false(handlerError.retryable);
    t.regex(handlerError.message, /Intentional payload converter HandlerError for testing/);
  });
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test('Nexus operation codec PayloadValidationError is a non-retryable bad request', async (t) => {
  const { createWorker, registerNexusEndpoint, taskQueue } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  // Only fail when decoding the Nexus operation input ('hello'), so that the caller workflow's
  // own activation payloads still decode successfully and the operation is actually reached.
  let decodeAttempts = 0;
  const validationCodec: PayloadCodec = {
    async encode(payloads: Payload[]): Promise<Payload[]> {
      return payloads;
    },
    async decode(payloads: Payload[]): Promise<Payload[]> {
      for (const payload of payloads) {
        if (payload.data != null && Buffer.from(payload.data).toString() === '"hello"') {
          decodeAttempts++;
          throw createPayloadValidationError({
            violations: [{ path: 'input', reason: 'intentional payload validation failure for testing' }],
          });
        }
      }
      return payloads;
    },
  };

  const worker = await createWorker({
    dataConverter: { payloadCodecs: [validationCodec] },
    nexusServices: [
      nexus.serviceHandler(testService, {
        async echoOp(_ctx, input) {
          return input;
        },
      }),
    ],
  });

  const customClient = new Client({
    connection: t.context.env.connection,
    dataConverter: { payloadCodecs: [validationCodec] },
  });

  await worker.runUntil(async () => {
    const err = await t.throwsAsync(
      () =>
        customClient.workflow.execute(nexusEchoCaller, {
          taskQueue,
          workflowId: randomUUID(),
          args: [endpointName],
        }),
      {
        instanceOf: WorkflowFailedError,
      }
    );
    t.true(err!.cause instanceof NexusOperationFailure);
    const nexusFailure = err!.cause as NexusOperationFailure;
    t.true(nexusFailure.cause instanceof nexus.HandlerError);
    const handlerError = innermostHandlerError(nexusFailure.cause as nexus.HandlerError);
    // A non-retryable validation failure means the input is invalid, so BAD_REQUEST rather than
    // the INTERNAL any other ApplicationFailure from a codec gets.
    t.is(handlerError.type, 'BAD_REQUEST');
    t.false(handlerError.retryable);
    t.is(handlerError.message, 'Invalid operation input');
    // The wrapper message does not carry the codec's own message, so it has to survive on the cause.
    t.true(handlerError.cause instanceof ApplicationFailure);
    const cause = handlerError.cause as ApplicationFailure;
    t.is(cause.type, 'PayloadValidationError');
    t.is(cause.message, 'Payload validation failed');
  });

  // Non-retryable, so the input is only decoded once.
  t.is(decodeAttempts, 1);
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test('Nexus operation converter PayloadValidationError is a non-retryable bad request', async (t) => {
  const { createWorker, registerNexusEndpoint, taskQueue } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    dataConverter: { payloadConverterPath: require.resolve('./payload-validation-failing-payload-converter') },
    nexusServices: [
      nexus.serviceHandler(testService, {
        async echoOp(_ctx, input) {
          return input;
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const err = await t.throwsAsync(
      () =>
        t.context.env.client.workflow.execute(nexusEchoCaller, {
          taskQueue,
          workflowId: randomUUID(),
          args: [endpointName],
        }),
      {
        instanceOf: WorkflowFailedError,
      }
    );
    t.true(err!.cause instanceof NexusOperationFailure);
    const nexusFailure = err!.cause as NexusOperationFailure;
    t.true(nexusFailure.cause instanceof nexus.HandlerError);
    const handlerError = innermostHandlerError(nexusFailure.cause as nexus.HandlerError);
    t.is(handlerError.type, 'BAD_REQUEST');
    t.false(handlerError.retryable);
    // A validation failure gets its own message, distinct from the generic decode failure.
    t.is(handlerError.message, 'Invalid operation input');
    t.notRegex(handlerError.message, /Payload converter failed to decode/);
    t.true(handlerError.cause instanceof ApplicationFailure);
    const cause = handlerError.cause as ApplicationFailure;
    t.is(cause.type, 'PayloadValidationError');
    t.is(cause.message, 'Payload validation failed');
  });
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test('Nexus operation output PayloadValidationError is retryable and eventually succeeds', async (t) => {
  const { createWorker, registerNexusEndpoint, taskQueue } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  let failCodec = true;
  const validationCodec: PayloadCodec = {
    async encode(payloads: Payload[]): Promise<Payload[]> {
      for (const payload of payloads) {
        if (failCodec && payload.data != null && Buffer.from(payload.data).toString() === '"validation-output"') {
          throw createPayloadValidationError({ field: 'output' });
        }
      }
      return payloads;
    },
    async decode(payloads: Payload[]): Promise<Payload[]> {
      return payloads;
    },
  };

  const worker = await createWorker({
    dataConverter: { payloadCodecs: [validationCodec] },
    nexusServices: [
      nexus.serviceHandler(testService, {
        async echoOp() {
          return 'validation-output';
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await t.context.env.client.workflow.start(nexusValidationOutputRetryCaller, {
      taskQueue,
      workflowId: randomUUID(),
      args: [endpointName],
    });

    let lastAttemptFailure: temporal.api.failure.v1.IFailure | null | undefined;
    await waitUntil(async () => {
      const description = await handle.describe();
      const pendingOperations = description.raw.pendingNexusOperations ?? [];
      lastAttemptFailure = pendingOperations[0]?.lastAttemptFailure;
      return lastAttemptFailure != null;
    }, 10_000);

    const lastAttemptError = defaultFailureConverter.failureToError(lastAttemptFailure!, defaultPayloadConverter);
    t.true(lastAttemptError instanceof nexus.HandlerError);
    const handlerError = lastAttemptError as nexus.HandlerError;
    t.is(handlerError.type, 'INTERNAL');
    t.true(handlerError.retryable);
    t.true(handlerError.cause instanceof ApplicationFailure);
    const cause = handlerError.cause as ApplicationFailure;
    t.is(cause.type, 'PayloadValidationError');
    t.is(cause.message, 'Payload validation failed');
    t.true(cause.nonRetryable);
    t.deepEqual(cause.details, [{ field: 'output' }]);

    failCodec = false;

    t.deepEqual(await handle.result(), { nexusResult: 'validation-output' });
  });
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test('workflow-side Nexus input codec PVE fails one Workflow Task and then succeeds', async (t) => {
  const { createWorker, registerNexusEndpoint, taskQueue } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  let failed = false;
  const codec: PayloadCodec = {
    async encode(payloads) {
      if (
        !failed &&
        payloads.some(
          (payload) => defaultPayloadConverter.fromPayload<any>(payload)?.__payloadValidation === 'nexus-outbound'
        )
      ) {
        failed = true;
        throw createPayloadValidationError({ field: 'nexus-input' });
      }
      return payloads;
    },
    async decode(payloads) {
      return payloads;
    },
  };
  const worker = await createWorker({
    dataConverter: { payloadCodecs: [codec] },
    nexusServices: [
      nexus.serviceHandler(testService, {
        async echoOp(_ctx, input) {
          return input;
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await t.context.env.client.workflow.start(nexusEchoCaller, {
      taskQueue,
      workflowId: randomUUID(),
      args: [endpointName, { __payloadValidation: 'nexus-outbound' }],
    });
    t.deepEqual(await handle.result(), { __payloadValidation: 'nexus-outbound' });
    const history = await handle.fetchHistory();
    t.true(
      (history.events ?? []).some(
        (event) => event.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED
      )
    );
  });
});

test('workflow-side Nexus input converter PVE fails one Workflow Task and then succeeds', async (t) => {
  const { createWorker, registerNexusEndpoint, taskQueue } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const payloadConverterPath = require.resolve('./payload-converters/payload-validation-selective');
  const workflowBundle = await createTestWorkflowBundle({ workflowsPath: __filename, payloadConverterPath });
  const worker = await createWorker({
    workflowBundle,
    dataConverter: { payloadConverterPath },
    nexusServices: [
      nexus.serviceHandler(testService, {
        async echoOp(_ctx, input) {
          return input;
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await t.context.env.client.workflow.start(nexusEchoCaller, {
      taskQueue,
      workflowId: randomUUID(),
      args: [endpointName, { __payloadValidation: 'workflow-task-once', id: 'nexus-converter-input' }],
    });
    t.deepEqual(await handle.result(), {
      __payloadValidation: 'workflow-task-once',
      id: 'nexus-converter-input',
    });
    const history = await handle.fetchHistory();
    t.true(
      (history.events ?? []).some(
        (event) => event.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED
      )
    );
  });
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test('Nexus converter output PVE is retried and eventually succeeds', async (t) => {
  const { createWorker, registerNexusEndpoint, taskQueue } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  let handlerAttempts = 0;
  const worker = await createWorker({
    dataConverter: { payloadConverterPath: require.resolve('./payload-converters/payload-validation-selective') },
    nexusServices: [
      nexus.serviceHandler(testService, {
        async echoOp() {
          handlerAttempts++;
          return { __payloadValidation: 'encode-once', id: 'nexus-converter-output' } as any;
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    t.is(
      await t.context.env.client.workflow.execute(nexusOutputCaller, {
        taskQueue,
        workflowId: randomUUID(),
        args: [endpointName],
      }),
      'done'
    );
  });
  t.is(handlerAttempts, 2);
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test('handler-thrown PVE and retryable lookalike keep ordinary Nexus behavior', async (t) => {
  const { createWorker, registerNexusEndpoint, taskQueue } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  let nonRetryableAttempts = 0;
  let retryableAttempts = 0;
  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(testService, {
        async echoOp(_ctx, input) {
          if (input === 'non-retryable') {
            nonRetryableAttempts++;
            throw createPayloadValidationError({ field: 'handler' });
          }
          if (input === 'retryable' && retryableAttempts++ === 0) {
            throw ApplicationFailure.retryable('ordinary handler failure', 'PayloadValidationError');
          }
          return input;
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const error = await t.throwsAsync(
      t.context.env.client.workflow.execute(nexusEchoCaller, {
        taskQueue,
        workflowId: randomUUID(),
        args: [endpointName, 'non-retryable'],
      }),
      { instanceOf: WorkflowFailedError }
    );
    t.true(error?.cause instanceof NexusOperationFailure);
    const handlerError = innermostHandlerError(error?.cause?.cause as nexus.HandlerError);
    t.is(handlerError.type, 'INTERNAL');
    t.false(handlerError.retryable);
    t.true(handlerError.cause instanceof ApplicationFailure);

    t.is(
      await t.context.env.client.workflow.execute(nexusEchoCaller, {
        taskQueue,
        workflowId: randomUUID(),
        args: [endpointName, 'retryable'],
      }),
      'retryable'
    );
  });
  t.is(nonRetryableAttempts, 1);
  t.is(retryableAttempts, 2);
});
