import { randomUUID } from 'node:crypto';
import anyTest, { TestFn } from 'ava';
import { filter } from 'rxjs/operators';
import { firstValueFrom, Observable, Subject } from 'rxjs';
import { Client } from '@temporalio/client';
import { Info } from '@temporalio/activity';
import {
  DataConverter,
  FailureConverter,
  LoadedDataConverter,
  Payload,
  PayloadCodec,
  PayloadConverter,
  ProtoFailure,
  SerializationContext,
  defaultPayloadConverter,
} from '@temporalio/common';
import { withSerializationContext } from '@temporalio/common/lib/converter/serialization-context';
import { RUN_INTEGRATION_TESTS, TestWorkflowEnvironment, Worker, bundlerOptions } from './helpers';
import * as activities from './activities';
import { createActivities } from './activities/async-completer';
import {
  Tracer,
  activityContextTag,
  makeTracer,
  workflowContextTag,
} from './payload-converters/serialization-context-converter';
import {
  serializationContextAsyncCompletionWorkflow,
  serializationContextFinishSignal,
  serializationContextQuery,
  serializationContextUpdate,
  serializationContextWorkflow,
} from './workflows/serialization-context';

const test = anyTest as TestFn;

class IdentityPayloadConverter implements PayloadConverter {
  constructor(private readonly context?: SerializationContext) {}

  toPayload(value: unknown): Payload {
    return defaultPayloadConverter.toPayload(value);
  }

  fromPayload<T>(payload: Payload): T {
    return defaultPayloadConverter.fromPayload(payload);
  }

  withContext(context: SerializationContext): PayloadConverter {
    if (this.context === context) return this;
    return new IdentityPayloadConverter(context);
  }
}

class IdentityFailureConverter implements FailureConverter {
  constructor(private readonly context?: SerializationContext) {}

  errorToFailure(err: unknown): ProtoFailure {
    return { message: String(err ?? '') };
  }

  failureToError(failure: ProtoFailure): Error {
    return new Error(failure.message ?? '');
  }

  withContext(context: SerializationContext): FailureConverter {
    if (this.context === context) return this;
    return new IdentityFailureConverter(context);
  }
}

class IdentityCodec implements PayloadCodec {
  constructor(private readonly context?: SerializationContext) {}

  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads;
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads;
  }

  withContext(context: SerializationContext): PayloadCodec {
    if (this.context === context) return this;
    return new IdentityCodec(context);
  }
}

test('withSerializationContext preserves converter identity for no-op withContext hooks', (t) => {
  const payloadConverter: PayloadConverter = {
    toPayload(value: unknown): Payload {
      return defaultPayloadConverter.toPayload(value);
    },
    fromPayload<T>(payload: Payload): T {
      return defaultPayloadConverter.fromPayload(payload);
    },
    withContext() {
      return this;
    },
  };
  const failureConverter: FailureConverter = {
    errorToFailure(err: unknown): ProtoFailure {
      return { message: String(err ?? '') };
    },
    failureToError(failure: ProtoFailure): Error {
      return new Error(failure.message ?? '');
    },
    withContext() {
      return this;
    },
  };
  const codec: PayloadCodec = {
    async encode(payloads: Payload[]): Promise<Payload[]> {
      return payloads;
    },
    async decode(payloads: Payload[]): Promise<Payload[]> {
      return payloads;
    },
    withContext() {
      return this;
    },
  };

  const converter: LoadedDataConverter = {
    payloadConverter,
    failureConverter,
    payloadCodecs: [codec],
  };
  const context = { namespace: 'default', workflowId: 'wid' };
  const withContext = withSerializationContext(converter, context);

  // Guards the fast path: no unnecessary wrapper allocation when all components are identity.
  t.is(withContext, converter);
});

test('withSerializationContext rebinds supported converter components', (t) => {
  const context = { namespace: 'default', workflowId: 'wid' };

  const payloadConverter = new IdentityPayloadConverter();
  const failureConverter = new IdentityFailureConverter();
  const codec = new IdentityCodec();
  const converter: LoadedDataConverter = {
    payloadConverter,
    failureConverter,
    payloadCodecs: [codec],
  };

  const withContextConverter = withSerializationContext(converter, context);

  t.not(withContextConverter, converter);
  t.not(withContextConverter.payloadConverter, payloadConverter);
  t.not(withContextConverter.failureConverter, failureConverter);
  t.not(withContextConverter.payloadCodecs[0], codec);
});

interface IntegrationContext {
  env: TestWorkflowEnvironment;
}

const integrationTest = anyTest as TestFn<IntegrationContext>;

if (RUN_INTEGRATION_TESTS) {
  integrationTest.before(async (t) => {
    t.context = {
      env: await TestWorkflowEnvironment.createLocal(),
    };
  });

  integrationTest.after.always(async (t) => {
    await (t.context as Partial<IntegrationContext>).env?.teardown?.();
  });

  integrationTest.serial('consolidated workflow path uses expected serialization contexts', async (t) => {
    const converterPath = require.resolve('./payload-converters/serialization-context-converter');
    const dataConverter: DataConverter = {
      payloadConverterPath: converterPath,
      failureConverterPath: converterPath,
    };
    const taskQueue = `serialization-context-${randomUUID()}`;
    const client = new Client({
      connection: t.context.env.connection,
      dataConverter,
    });

    const worker = await Worker.create({
      connection: t.context.env.nativeConnection,
      workflowsPath: require.resolve('./workflows'),
      activities,
      taskQueue,
      dataConverter,
      bundlerOptions,
    });

    const namespace = client.options.namespace;
    const workflowId = randomUUID();
    const childWorkflowId = `child-${randomUUID()}`;
    const signalTargetWorkflowId = `missing-signal-${randomUUID()}`;
    const cancelTargetWorkflowId = `missing-cancel-${randomUUID()}`;
    const workflowTag = workflowContextTag({ namespace, workflowId });
    const childWorkflowTag = workflowContextTag({ namespace, workflowId: childWorkflowId });
    const signalWorkflowTag = workflowContextTag({ namespace, workflowId: signalTargetWorkflowId });
    const cancelWorkflowTag = workflowContextTag({ namespace, workflowId: cancelTargetWorkflowId });

    await worker.runUntil(async () => {
      const handle = await client.workflow.start(serializationContextWorkflow, {
        workflowId,
        taskQueue,
        args: [makeTracer('start-input'), childWorkflowId, signalTargetWorkflowId, cancelTargetWorkflowId],
      });

      const queryResult = await handle.query(serializationContextQuery, makeTracer('query-input'));
      const updateResult = await handle.executeUpdate(serializationContextUpdate, {
        args: [makeTracer('update-input')],
      });
      await handle.signal(serializationContextFinishSignal, makeTracer('finish-signal-input'));

      const result = await handle.result();

      // Workflow activities default activityId to seq, and this workflow schedules a single activity first.
      const activityTag = activityContextTag({ namespace, workflowId, activityId: '1', isLocal: false });

      // Start input: client encodes → workflow decodes
      t.deepEqual(result.startInput.trace, [`to:${workflowTag}`, `from:${workflowTag}`]);

      // Activity result: workflow encodes args → worker decodes args → worker encodes result → workflow decodes result
      t.deepEqual(result.activityResult.trace, [
        `to:${activityTag}`,
        `from:${activityTag}`,
        `to:${activityTag}`,
        `from:${activityTag}`,
      ]);

      // Child workflow result: parent encodes input → child decodes args → child encodes return → parent decodes result
      t.deepEqual(result.childResult.trace, [
        `to:${childWorkflowTag}`,
        `from:${childWorkflowTag}`,
        `to:${childWorkflowTag}`,
        `from:${childWorkflowTag}`,
      ]);

      // Query input: client encodes → workflow decodes
      t.deepEqual(result.seenQueryInput.trace, [`to:${workflowTag}`, `from:${workflowTag}`]);

      // Query result: workflow encodes response → client decodes (round trip through codec runner)
      t.deepEqual(queryResult.trace, [
        `to:${workflowTag}`,
        `from:${workflowTag}`,
        `to:${workflowTag}`,
        `from:${workflowTag}`,
      ]);

      // Update input: client encodes → workflow decodes
      t.deepEqual(result.seenUpdateInput.trace, [`to:${workflowTag}`, `from:${workflowTag}`]);

      // Update result: workflow encodes response → client decodes
      t.deepEqual(updateResult.trace, [
        `to:${workflowTag}`,
        `from:${workflowTag}`,
        `to:${workflowTag}`,
        `from:${workflowTag}`,
      ]);

      // Signal input: client encodes → workflow decodes
      t.deepEqual(result.seenSignalInput.trace, [`to:${workflowTag}`, `from:${workflowTag}`]);

      // External signal failure: error message contains target workflow's context tag
      t.true(
        result.signalExternalErrorMessage.includes(`failureToError:${signalWorkflowTag}`),
        `signalExternal error missing context tag: ${result.signalExternalErrorMessage}`
      );

      // External cancel failure: error message contains target workflow's context tag
      t.true(
        result.cancelExternalErrorMessage.includes(`failureToError:${cancelWorkflowTag}`),
        `cancelExternal error missing context tag: ${result.cancelExternalErrorMessage}`
      );
    });
  });

  integrationTest.serial('schedule action conversions use target workflow serialization context', async (t) => {
    const converterPath = require.resolve('./payload-converters/serialization-context-converter');
    const dataConverter: DataConverter = {
      payloadConverterPath: converterPath,
      failureConverterPath: converterPath,
    };

    const client = new Client({ connection: t.context.env.connection, dataConverter });
    const namespace = client.options.namespace;
    const scheduleId = `serialization-context-schedule-${randomUUID()}`;
    const actionWorkflowId = `scheduled-${randomUUID()}`;
    const workflowTag = workflowContextTag({ namespace, workflowId: actionWorkflowId });

    const handle = await client.schedule.create({
      scheduleId,
      spec: {
        intervals: [{ every: '1h' }],
      },
      action: {
        type: 'startWorkflow',
        workflowType: async (_arg: Tracer) => undefined,
        workflowId: actionWorkflowId,
        taskQueue: `serialization-context-schedule-${randomUUID()}`,
        args: [makeTracer('schedule-arg')],
        memo: {
          tracer: makeTracer('schedule-memo'),
        },
      },
    });

    try {
      const described = await handle.describe();
      const argTracer = described.action.type === 'startWorkflow' ? (described.action.args?.[0] as Tracer) : undefined;
      const memoTracer =
        described.action.type === 'startWorkflow' ? (described.action.memo?.tracer as Tracer) ?? undefined : undefined;

      t.truthy(argTracer);
      t.truthy(memoTracer);
      // Schedule arg/memo: client encodes with target workflow context → client decodes on describe
      t.deepEqual(argTracer!.trace, [`to:${workflowTag}`, `from:${workflowTag}`]);
      t.deepEqual(memoTracer!.trace, [`to:${workflowTag}`, `from:${workflowTag}`]);
    } finally {
      await handle.delete();
    }
  });

  integrationTest.serial('async completion uses withContext binding for serialization context', async (t) => {
    const converterPath = require.resolve('./payload-converters/serialization-context-converter');
    const dataConverter: DataConverter = {
      payloadConverterPath: converterPath,
      failureConverterPath: converterPath,
    };

    const infoSubject = new Subject<Info>();
    const taskQueue = `serialization-context-async-${randomUUID()}`;
    const worker = await Worker.create({
      connection: t.context.env.nativeConnection,
      workflowsPath: require.resolve('./workflows'),
      activities: createActivities(infoSubject),
      taskQueue,
      dataConverter,
      bundlerOptions,
    });
    const runPromise = worker.run();
    runPromise.catch(() => undefined);

    const client = new Client({
      connection: t.context.env.connection,
      dataConverter,
    });
    const namespace = client.options.namespace;

    async function activityStarted(workflowId: string): Promise<Info> {
      return await firstValueFrom(
        (infoSubject as Observable<Info>).pipe(filter((info) => info.workflowExecution.workflowId === workflowId))
      );
    }

    try {
      const workflowIdById = `async-by-id-${randomUUID()}`;
      const byIdHandle = await client.workflow.start(serializationContextAsyncCompletionWorkflow, {
        workflowId: workflowIdById,
        taskQueue,
      });
      const byIdInfo = await activityStarted(workflowIdById);
      await client.activity.complete(
        { workflowId: workflowIdById, activityId: byIdInfo.activityId },
        makeTracer('async-by-id')
      );
      const byIdResult = (await byIdHandle.result()) as Tracer;
      const byIdActivityTag = activityContextTag({
        namespace,
        workflowId: workflowIdById,
        activityId: byIdInfo.activityId,
        isLocal: false,
      });
      const byIdWorkflowTag = workflowContextTag({ namespace, workflowId: workflowIdById });
      // By-ID without withContext(): client encodes with no context → worker decodes with activity context →
      // workflow encodes return → client decodes
      t.deepEqual(byIdResult.trace, [
        `to:none`,
        `from:${byIdActivityTag}`,
        `to:${byIdWorkflowTag}`,
        `from:${byIdWorkflowTag}`,
      ]);

      const workflowIdBoundToken = `async-bound-token-${randomUUID()}`;
      const boundHandle = await client.workflow.start(serializationContextAsyncCompletionWorkflow, {
        workflowId: workflowIdBoundToken,
        taskQueue,
      });
      const boundInfo = await activityStarted(workflowIdBoundToken);
      await client.activity
        .withContext({ namespace, workflowId: workflowIdBoundToken })
        .complete(boundInfo.taskToken, makeTracer('async-bound-token'));
      const boundResult = (await boundHandle.result()) as Tracer;
      const boundActivityTag = activityContextTag({
        namespace,
        workflowId: workflowIdBoundToken,
        activityId: boundInfo.activityId,
        isLocal: false,
      });
      const boundWorkflowTag = workflowContextTag({ namespace, workflowId: workflowIdBoundToken });
      // Bound token with withContext(): client encodes with workflow context → worker decodes with activity context →
      // workflow encodes return → client decodes
      t.deepEqual(boundResult.trace, [
        `to:${boundWorkflowTag}`,
        `from:${boundActivityTag}`,
        `to:${boundWorkflowTag}`,
        `from:${boundWorkflowTag}`,
      ]);

      const workflowIdUnboundToken = `async-unbound-token-${randomUUID()}`;
      const unboundHandle = await client.workflow.start(serializationContextAsyncCompletionWorkflow, {
        workflowId: workflowIdUnboundToken,
        taskQueue,
      });
      const unboundInfo = await activityStarted(workflowIdUnboundToken);
      await client.activity.complete(unboundInfo.taskToken, makeTracer('async-unbound-token'));
      const unboundResult = (await unboundHandle.result()) as Tracer;
      const unboundActivityTag = activityContextTag({
        namespace,
        workflowId: workflowIdUnboundToken,
        activityId: unboundInfo.activityId,
        isLocal: false,
      });
      const unboundWorkflowTag = workflowContextTag({ namespace, workflowId: workflowIdUnboundToken });
      // Unbound token without withContext(): same as by-ID — no client context
      t.deepEqual(unboundResult.trace, [
        `to:none`,
        `from:${unboundActivityTag}`,
        `to:${unboundWorkflowTag}`,
        `from:${unboundWorkflowTag}`,
      ]);
    } finally {
      worker.shutdown();
      await runPromise;
    }
  });
}
