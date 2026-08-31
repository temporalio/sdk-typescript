import { randomUUID } from 'node:crypto';
import { activityInfo } from '@temporalio/activity';
import type { Payload, PayloadCodec } from '@temporalio/common';
import { createPayloadValidationError, defaultPayloadConverter } from '@temporalio/common';
import {
  ActivityFailure,
  ActivityExecutionFailedError,
  ApplicationFailure,
  ChildWorkflowFailure,
  WorkflowFailedError,
  WorkflowUpdateFailedError,
} from '@temporalio/client';
import proto from '@temporalio/proto'; // eslint-disable-line import/default
import type { LogEntry } from '@temporalio/worker';
import { MetricsBuffer, Worker } from '@temporalio/worker';
import { assertEventually } from './helpers';
import type { Context as BaseContext } from './helpers-integration';
import {
  configurableHelpers,
  createTestWorkflowBundle,
  createTestWorkflowEnvironment,
  makeConfigurableEnvironmentTestFn,
} from './helpers-integration';
import {
  payloadValidationActivityInputWorkflow,
  payloadValidationActivityOutputWorkflow,
  payloadValidationChildInputWorkflow,
  payloadValidationContinueAsNewWorkflow,
  payloadValidationEagerActivityInputWorkflow,
  payloadValidationInputWorkflow,
  payloadValidationEagerActivityOutputWorkflow,
  payloadValidationHandlerFailureWorkflow,
  payloadValidationLocalActivityInputWorkflow,
  payloadValidationLocalActivityOutputWorkflow,
  payloadValidationMessageWorkflow,
  payloadValidationOutboundWorkflow,
  payloadValidationOutputWorkflow,
  payloadValidationSignalTargetWorkflow,
} from './workflows/payload-validation-error';

const converterPath = require.resolve('./payload-converters/payload-validation-selective');
const { EventType } = proto.temporal.api.enums.v1;
const dataConverter = { payloadConverterPath: converterPath };
const invalid = (id: string) => ({ __payloadValidation: 'decode', id });
const recordedLogs: { [workflowId: string]: LogEntry[] } = {};
const metricsBuffer = new MetricsBuffer();

interface Context extends BaseContext {
  metricsBuffer: MetricsBuffer;
}

class FailOncePayloadCodec implements PayloadCodec {
  private readonly failed = new Set<string>();

  async encode(payloads: Payload[]): Promise<Payload[]> {
    for (const payload of payloads) {
      const value = defaultPayloadConverter.fromPayload<any>(payload);
      const id =
        value?.__payloadValidation === 'codec-encode-once'
          ? value.id
          : typeof value === 'string' && value.startsWith('codec-encode-once:')
            ? value.slice('codec-encode-once:'.length)
            : undefined;
      if (id !== undefined && !this.failed.has(id)) {
        this.failed.add(id);
        throw createPayloadValidationError({ field: id });
      }
    }
    return payloads;
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    for (const payload of payloads) {
      const value = defaultPayloadConverter.fromPayload<any>(payload);
      if (value?.__payloadValidation === 'codec-decode') {
        throw createPayloadValidationError({ field: value.id });
      }
    }
    return payloads;
  }
}

const test = makeConfigurableEnvironmentTestFn<Context>({
  recordedLogs,
  runtimeOpts: { telemetryOptions: { metrics: { buffer: metricsBuffer } } },
  createTestContext: async () => {
    const env = await createTestWorkflowEnvironment();
    const workflowBundle = await createTestWorkflowBundle({
      workflowsPath: require.resolve('./workflows/payload-validation-error'),
      payloadConverterPath: converterPath,
    });
    return { env, workflowBundle, metricsBuffer };
  },
  teardown: async (context) => context.env.teardown(),
});

function assertPve(error: unknown): void {
  if (!(error instanceof ApplicationFailure)) throw error;
  if (error.type !== 'PayloadValidationError' || !error.nonRetryable) throw error;
}

test('workflow input fails execution with PayloadValidationError', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const worker = await h.createWorker({ dataConverter });
  await worker.runUntil(async () => {
    const error = await t.throwsAsync(
      t.context.env.client.workflow.execute(payloadValidationInputWorkflow, {
        workflowId: randomUUID(),
        taskQueue: h.taskQueue,
        args: [invalid('workflow-input')],
      }),
      { instanceOf: WorkflowFailedError }
    );
    assertPve(error?.cause);
  });
});

test('child workflow input fails execution with ChildWorkflowFailure caused by PVE', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const worker = await h.createWorker({ dataConverter });
  await worker.runUntil(async () => {
    const error = await t.throwsAsync(
      t.context.env.client.workflow.execute(payloadValidationChildInputWorkflow, {
        workflowId: randomUUID(),
        taskQueue: h.taskQueue,
        args: ['child-workflow-input'],
      }),
      { instanceOf: WorkflowFailedError }
    );
    t.true(error?.cause instanceof ChildWorkflowFailure);
    assertPve(error?.cause?.cause);
  });
});

test('codec workflow and child input fail execution with direct PVE causes', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const worker = await h.createWorker({
    dataConverter: { ...dataConverter, payloadCodecs: [new FailOncePayloadCodec()] },
  });
  await worker.runUntil(async () => {
    const directError = await t.throwsAsync(
      t.context.env.client.workflow.execute(payloadValidationInputWorkflow, {
        workflowId: randomUUID(),
        taskQueue: h.taskQueue,
        args: [{ __payloadValidation: 'codec-decode', id: 'workflow-codec-input' }],
      }),
      { instanceOf: WorkflowFailedError }
    );
    assertPve(directError?.cause);

    const childError = await t.throwsAsync(
      t.context.env.client.workflow.execute(payloadValidationChildInputWorkflow, {
        workflowId: randomUUID(),
        taskQueue: h.taskQueue,
        args: ['child-codec-input', 'codec-decode'],
      }),
      { instanceOf: WorkflowFailedError }
    );
    t.true(childError?.cause instanceof ChildWorkflowFailure);
    assertPve(childError?.cause?.cause);
  });
});

test('handler-thrown exact and retryable same-type failures keep ordinary workflow behavior', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const worker = await h.createWorker({ dataConverter });
  await worker.runUntil(async () => {
    for (const retryable of [false, true]) {
      const error = await t.throwsAsync(
        t.context.env.client.workflow.execute(payloadValidationHandlerFailureWorkflow, {
          workflowId: randomUUID(),
          taskQueue: h.taskQueue,
          args: [retryable],
        }),
        { instanceOf: WorkflowFailedError }
      );
      const cause = error?.cause;
      t.true(cause instanceof ApplicationFailure);
      if (!(cause instanceof ApplicationFailure)) throw cause;
      t.is(cause.type, 'PayloadValidationError');
      t.is(cause.nonRetryable, !retryable);
    }
  });
});

test('query and update input fail independently and a corrupted signal is dropped', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const worker = await h.createWorker({ dataConverter });
  await worker.runUntil(async () => {
    const handle = await t.context.env.client.workflow.start(payloadValidationMessageWorkflow, {
      workflowId: randomUUID(),
      taskQueue: h.taskQueue,
    });
    const queryError = await t.throwsAsync(handle.query('invalidQuery', invalid('query-input')));
    t.regex(queryError!.message, /Payload validation failed/);
    const updateError = await t.throwsAsync(
      handle.executeUpdate('invalidUpdate', { args: [invalid('update-input')] }),
      {
        instanceOf: WorkflowUpdateFailedError,
      }
    );
    assertPve(updateError?.cause);
    await handle.signal('invalidSignal', invalid('signal-input'));
    await handle.signal('validSignal');
    t.is(await handle.result(), 'done');

    const corruptedSignalMetrics = Array.from(t.context.metricsBuffer.retrieveUpdates()).filter(
      (update) => update.metric.name.endsWith('corrupted_signals') && update.attributes.taskQueue === h.taskQueue
    );
    t.is(corruptedSignalMetrics.length, 1);
    t.is(corruptedSignalMetrics[0]?.value, 1);
    t.like(corruptedSignalMetrics[0]?.attributes, {
      namespace: 'default',
      taskQueue: h.taskQueue,
      workflowType: payloadValidationMessageWorkflow.name,
    });
    const logs = recordedLogs[handle.workflowId] ?? [];
    t.is(logs.filter((entry) => entry.message === 'Failed to convert signal input; dropping signal').length, 1);

    const history = await t.context.env.client.workflow
      .getHandle(handle.workflowId, handle.firstExecutionRunId)
      .fetchHistory();
    await Worker.runReplayHistory(
      { workflowBundle: t.context.workflowBundle, dataConverter },
      history,
      handle.workflowId
    );
    t.is(
      Array.from(t.context.metricsBuffer.retrieveUpdates()).filter(
        (update) => update.metric.name.endsWith('corrupted_signals') && update.attributes.taskQueue === h.taskQueue
      ).length,
      0
    );
    t.is(logs.filter((entry) => entry.message === 'Failed to convert signal input; dropping signal').length, 1);
  });
});

test('a corrupted signal is dropped from a mixed initialization activation', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const worker = await h.createWorker({ dataConverter });
  await worker.runUntil(async () => {
    const handle = await t.context.env.client.workflow.signalWithStart(payloadValidationMessageWorkflow, {
      workflowId: randomUUID(),
      taskQueue: h.taskQueue,
      signal: 'invalidSignal',
      signalArgs: [invalid('mixed-activation-signal')],
      args: [],
    });
    await handle.signal('validSignal');
    t.is(await handle.result(), 'done');
    const history = await handle.fetchHistory();
    t.false((history.events ?? []).some((event) => event.eventType === EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED));
  });
});

test('codec query and update input are isolated and a codec-corrupted signal is replay-safe', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const codec = new FailOncePayloadCodec();
  const workerDataConverter = { ...dataConverter, payloadCodecs: [codec] };
  const worker = await h.createWorker({ dataConverter: workerDataConverter });
  await worker.runUntil(async () => {
    const handle = await t.context.env.client.workflow.start(payloadValidationMessageWorkflow, {
      workflowId: randomUUID(),
      taskQueue: h.taskQueue,
    });
    const invalidCodecValue = (id: string) => ({ __payloadValidation: 'codec-decode', id });
    const queryError = await t.throwsAsync(handle.query('invalidQuery', invalidCodecValue('codec-query')));
    t.regex(queryError!.message, /Payload validation failed/);
    const updateError = await t.throwsAsync(
      handle.executeUpdate('invalidUpdate', { args: [invalidCodecValue('codec-update')] }),
      { instanceOf: WorkflowUpdateFailedError }
    );
    assertPve(updateError?.cause);
    await handle.signal('invalidSignal', invalidCodecValue('codec-signal'));
    await handle.signal('validSignal');
    t.is(await handle.result(), 'done');

    const corruptedSignalMetrics = Array.from(t.context.metricsBuffer.retrieveUpdates()).filter(
      (update) => update.metric.name.endsWith('corrupted_signals') && update.attributes.taskQueue === h.taskQueue
    );
    t.is(corruptedSignalMetrics.length, 1);
    const logs = recordedLogs[handle.workflowId] ?? [];
    t.is(logs.filter((entry) => entry.message === 'Failed to convert signal input; dropping signal').length, 1);

    const history = await handle.fetchHistory();
    await Worker.runReplayHistory(
      { workflowBundle: t.context.workflowBundle, dataConverter: workerDataConverter },
      history,
      handle.workflowId
    );
    t.is(
      Array.from(t.context.metricsBuffer.retrieveUpdates()).filter(
        (update) => update.metric.name.endsWith('corrupted_signals') && update.attributes.taskQueue === h.taskQueue
      ).length,
      0
    );
    t.is(logs.filter((entry) => entry.message === 'Failed to convert signal input; dropping signal').length, 1);
  });
});

test('query and update result conversion fails only that request', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const worker = await h.createWorker({ dataConverter });
  await worker.runUntil(async () => {
    const handle = await t.context.env.client.workflow.start(payloadValidationMessageWorkflow, {
      workflowId: randomUUID(),
      taskQueue: h.taskQueue,
    });
    const queryError = await t.throwsAsync(
      handle.query('invalidQuery', { __payloadValidation: 'encode-once', id: 'query-result' })
    );
    t.regex(queryError!.message, /Payload validation failed/);
    t.deepEqual(await handle.query('invalidQuery', 'valid-query'), 'valid-query');

    const updateError = await t.throwsAsync(
      handle.executeUpdate('invalidUpdate', {
        args: [{ __payloadValidation: 'encode-once', id: 'update-result' }],
      }),
      { instanceOf: WorkflowUpdateFailedError }
    );
    assertPve(updateError?.cause);
    t.is(await handle.executeUpdate('invalidUpdate', { args: ['valid-update'] }), 'valid-update');
    await handle.signal('validSignal');
    t.is(await handle.result(), 'done');
  });
});

test('codec query and update result conversion fails only that request', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const worker = await h.createWorker({
    dataConverter: { ...dataConverter, payloadCodecs: [new FailOncePayloadCodec()] },
  });
  await worker.runUntil(async () => {
    const handle = await t.context.env.client.workflow.start(payloadValidationMessageWorkflow, {
      workflowId: randomUUID(),
      taskQueue: h.taskQueue,
    });
    const queryError = await t.throwsAsync(
      handle.query('invalidQuery', { __payloadValidation: 'codec-encode-once', id: 'codec-query-result' })
    );
    t.regex(queryError!.message, /Payload validation failed/);
    t.deepEqual(await handle.query('invalidQuery', 'valid-query'), 'valid-query');

    const updateError = await t.throwsAsync(
      handle.executeUpdate('invalidUpdate', {
        args: [{ __payloadValidation: 'codec-encode-once', id: 'codec-update-result' }],
      }),
      { instanceOf: WorkflowUpdateFailedError }
    );
    assertPve(updateError?.cause);
    t.is(await handle.executeUpdate('invalidUpdate', { args: ['valid-update'] }), 'valid-update');
    await handle.signal('validSignal');
    t.is(await handle.result(), 'done');
  });
});

test('workflow output conversion fails one Workflow Task and then replays successfully', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const worker = await h.createWorker({
    dataConverter: { ...dataConverter, payloadCodecs: [new FailOncePayloadCodec()] },
  });
  await worker.runUntil(async () => {
    const handle = await t.context.env.client.workflow.start(payloadValidationOutputWorkflow, {
      workflowId: randomUUID(),
      taskQueue: h.taskQueue,
      args: [randomUUID()],
    });
    t.truthy(await handle.result());
    const history = await t.context.env.client.workflow
      .getHandle(handle.workflowId, handle.firstExecutionRunId)
      .fetchHistory();
    t.true((history.events ?? []).some((event) => event.eventType === EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED));
  });
});

test('continue-as-new conversion fails one Workflow Task and then replays successfully', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const worker = await h.createWorker({
    dataConverter: { ...dataConverter, payloadCodecs: [new FailOncePayloadCodec()] },
  });
  await worker.runUntil(async () => {
    const handle = await t.context.env.client.workflow.start(payloadValidationContinueAsNewWorkflow, {
      workflowId: randomUUID(),
      taskQueue: h.taskQueue,
      args: [{ id: randomUUID() }],
    });
    t.is(await handle.result(), 'continued');
    const history = await t.context.env.client.workflow
      .getHandle(handle.workflowId, handle.firstExecutionRunId)
      .fetchHistory();
    t.true((history.events ?? []).some((event) => event.eventType === EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED));
  });
});

test('converter workflow completion and continue-as-new fail one Workflow Task and replay', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const worker = await h.createWorker({ dataConverter });
  await worker.runUntil(async () => {
    const handles = [
      () =>
        t.context.env.client.workflow.start(payloadValidationOutputWorkflow, {
          workflowId: randomUUID(),
          taskQueue: h.taskQueue,
          args: [randomUUID(), 'workflow-task-once'],
        }),
      () =>
        t.context.env.client.workflow.start(payloadValidationContinueAsNewWorkflow, {
          workflowId: randomUUID(),
          taskQueue: h.taskQueue,
          args: [{ id: randomUUID(), marker: 'workflow-task-once' }],
        }),
    ];

    for (const start of handles) {
      const handle = await start();
      t.truthy(await handle.result());
      const history = await t.context.env.client.workflow
        .getHandle(handle.workflowId, handle.firstExecutionRunId)
        .fetchHistory();
      t.true((history.events ?? []).some((event) => event.eventType === EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED));
      t.false(
        (history.events ?? []).some((event) => event.eventType === EventType.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED)
      );
    }
  });
});

test('outbound workflow payload paths fail one Workflow Task and then succeed', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const worker = await h.createWorker({
    dataConverter: { ...dataConverter, payloadCodecs: [new FailOncePayloadCodec()] },
    activities: {
      payloadValidationActivity(input: unknown) {
        return input;
      },
    },
  });
  await worker.runUntil(async () => {
    for (const kind of ['activity', 'local-activity', 'child', 'child-signal', 'memo', 'user-metadata'] as const) {
      const handle = await t.context.env.client.workflow.start(payloadValidationOutboundWorkflow, {
        workflowId: randomUUID(),
        taskQueue: h.taskQueue,
        args: [kind, randomUUID()],
      });
      t.is(await handle.result(), 'done');
      const history = await handle.fetchHistory();
      t.true(
        (history.events ?? []).some((event) => event.eventType === EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED),
        kind
      );
    }

    const target = await t.context.env.client.workflow.start(payloadValidationSignalTargetWorkflow, {
      workflowId: randomUUID(),
      taskQueue: h.taskQueue,
    });
    const signalCaller = await t.context.env.client.workflow.start(payloadValidationOutboundWorkflow, {
      workflowId: randomUUID(),
      taskQueue: h.taskQueue,
      args: ['signal', randomUUID(), target.workflowId],
    });
    t.is(await signalCaller.result(), 'done');
    t.truthy(await target.result());
    const signalHistory = await signalCaller.fetchHistory();
    t.true((signalHistory.events ?? []).some((event) => event.eventType === EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED));
  });
});

test('converter outbound workflow payload paths fail one Workflow Task and replay', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const worker = await h.createWorker({
    dataConverter,
    activities: {
      payloadValidationActivity(input: unknown) {
        return input;
      },
    },
  });
  await worker.runUntil(async () => {
    for (const kind of ['activity', 'local-activity', 'child', 'memo', 'user-metadata'] as const) {
      const handle = await t.context.env.client.workflow.start(payloadValidationOutboundWorkflow, {
        workflowId: randomUUID(),
        taskQueue: h.taskQueue,
        args: [kind, randomUUID(), undefined, 'workflow-task-once'],
      });
      t.is(await handle.result(), 'done');
      const history = await handle.fetchHistory();
      t.true(
        (history.events ?? []).some((event) => event.eventType === EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED),
        kind
      );
    }

    const target = await t.context.env.client.workflow.start(payloadValidationSignalTargetWorkflow, {
      workflowId: randomUUID(),
      taskQueue: h.taskQueue,
    });
    const signalCaller = await t.context.env.client.workflow.start(payloadValidationOutboundWorkflow, {
      workflowId: randomUUID(),
      taskQueue: h.taskQueue,
      args: ['signal', randomUUID(), target.workflowId, 'workflow-task-once'],
    });
    t.is(await signalCaller.result(), 'done');
    t.truthy(await target.result());
    const signalHistory = await signalCaller.fetchHistory();
    t.true((signalHistory.events ?? []).some((event) => event.eventType === EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED));
  });
});

test('converter child-handle signal conversion remains a Workflow Task failure', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const worker = await h.createWorker({ dataConverter });
  await worker.runUntil(async () => {
    const handle = await t.context.env.client.workflow.start(payloadValidationOutboundWorkflow, {
      workflowId: randomUUID(),
      taskQueue: h.taskQueue,
      args: ['child-signal', randomUUID(), undefined, 'encode-always'],
    });
    await assertEventually(t, async (tt) => {
      const history = await handle.fetchHistory();
      tt.true((history.events ?? []).some((event) => event.eventType === EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED));
      tt.false(
        (history.events ?? []).some((event) => event.eventType === EventType.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED)
      );
    });
    await handle.terminate('test complete');
  });
});

test('Activity input has direct PVE cause and automatic output is retried', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  let invalidInputInvocations = 0;
  const worker = await h.createWorker({
    dataConverter,
    activities: {
      payloadValidationActivity(input: any) {
        if (input?.__payloadValidation === 'decode') {
          invalidInputInvocations++;
          throw new Error('activity handler was invoked');
        }
        return { __payloadValidation: 'encode-once', ...input, attempt: activityInfo().attempt };
      },
    },
  });
  await worker.runUntil(async () => {
    const inputHandle = await t.context.env.client.workflow.start(payloadValidationActivityInputWorkflow, {
      workflowId: randomUUID(),
      taskQueue: h.taskQueue,
      args: [{ activityInput: invalid('activity-input') }],
    });
    const inputError = await t.throwsAsync(inputHandle.result(), { instanceOf: WorkflowFailedError });
    t.true(inputError?.cause instanceof ActivityFailure);
    assertPve(inputError?.cause?.cause);
    const inputHistory = await inputHandle.fetchHistory();
    t.is(
      (inputHistory.events ?? []).filter((event) => event.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_STARTED)
        .length,
      1
    );
    t.is(
      (inputHistory.events ?? []).filter((event) => event.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED)
        .length,
      1
    );

    for (const workflowType of [
      payloadValidationLocalActivityInputWorkflow,
      payloadValidationEagerActivityInputWorkflow,
    ]) {
      const variantError = await t.throwsAsync(
        t.context.env.client.workflow.execute(workflowType, {
          workflowId: randomUUID(),
          taskQueue: h.taskQueue,
          args: [{ activityInput: invalid(workflowType.name) }],
        }),
        { instanceOf: WorkflowFailedError }
      );
      t.true(variantError?.cause instanceof ActivityFailure);
      assertPve(variantError?.cause?.cause);
    }
    t.is(invalidInputInvocations, 0);

    const attempt = await t.context.env.client.workflow.execute(payloadValidationActivityOutputWorkflow, {
      workflowId: randomUUID(),
      taskQueue: h.taskQueue,
      args: [randomUUID()],
    });
    t.is(attempt, 2);

    const localAttempt = await t.context.env.client.workflow.execute(payloadValidationLocalActivityOutputWorkflow, {
      workflowId: randomUUID(),
      taskQueue: h.taskQueue,
      args: [randomUUID()],
    });
    t.is(localAttempt, 2);

    const eagerAttempt = await t.context.env.client.workflow.execute(payloadValidationEagerActivityOutputWorkflow, {
      workflowId: randomUUID(),
      taskQueue: h.taskQueue,
      args: [randomUUID()],
    });
    t.is(eagerAttempt, 2);
  });
});

test('Activity codec input and output follow remote, local, eager, and standalone boundaries', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  let invalidInputInvocations = 0;
  const codec = new FailOncePayloadCodec();
  const worker = await h.createWorker({
    dataConverter: { ...dataConverter, payloadCodecs: [codec] },
    activities: {
      payloadValidationActivity(input: any) {
        if (input?.__payloadValidation === 'codec-decode') {
          invalidInputInvocations++;
          throw new Error('activity handler was invoked');
        }
        return {
          __payloadValidation: 'codec-encode-once',
          id: input.id,
          attempt: activityInfo().attempt,
        };
      },
    },
  });
  await worker.runUntil(async () => {
    for (const workflowType of [
      payloadValidationActivityInputWorkflow,
      payloadValidationLocalActivityInputWorkflow,
      payloadValidationEagerActivityInputWorkflow,
    ]) {
      const handle = await t.context.env.client.workflow.start(workflowType, {
        workflowId: randomUUID(),
        taskQueue: h.taskQueue,
        args: [{ activityInput: { __payloadValidation: 'codec-decode', id: workflowType.name } }],
      });
      const error = await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
      t.true(error?.cause instanceof ActivityFailure);
      assertPve(error?.cause?.cause);
      if (workflowType === payloadValidationActivityInputWorkflow) {
        const history = await handle.fetchHistory();
        t.is(
          (history.events ?? []).filter((event) => event.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_STARTED)
            .length,
          1
        );
        t.is(
          (history.events ?? []).filter((event) => event.eventType === EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED)
            .length,
          1
        );
      }
    }
    t.is(invalidInputInvocations, 0);

    for (const workflowType of [
      payloadValidationActivityOutputWorkflow,
      payloadValidationLocalActivityOutputWorkflow,
      payloadValidationEagerActivityOutputWorkflow,
    ]) {
      t.is(
        await t.context.env.client.workflow.execute(workflowType, {
          workflowId: randomUUID(),
          taskQueue: h.taskQueue,
          args: [randomUUID()],
        }),
        2
      );
    }

    const options = {
      taskQueue: h.taskQueue,
      scheduleToCloseTimeout: '10s',
      retry: { maximumAttempts: 3 },
    } as const;
    const inputError = await t.throwsAsync(
      t.context.env.client.activity.execute('payloadValidationActivity', {
        ...options,
        id: randomUUID(),
        args: [{ __payloadValidation: 'codec-decode', id: 'standalone-codec-input' }],
      }),
      { instanceOf: ActivityExecutionFailedError }
    );
    assertPve(inputError?.cause);
    const result = await t.context.env.client.activity.execute<any>('payloadValidationActivity', {
      ...options,
      id: randomUUID(),
      args: [{ id: randomUUID() }],
    });
    t.is(result.attempt, 2);
  });
});

test('standalone Activity input is non-retryable and automatic output is retried', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  let inputInvocations = 0;
  const worker = await h.createWorker({
    dataConverter,
    activities: {
      payloadValidationActivity(input: any) {
        if (input?.__payloadValidation === 'decode') {
          inputInvocations++;
          throw new Error('standalone activity handler was invoked');
        }
        return { __payloadValidation: 'encode-once', ...input, attempt: activityInfo().attempt };
      },
    },
  });
  await worker.runUntil(async () => {
    const options = {
      taskQueue: h.taskQueue,
      scheduleToCloseTimeout: '10s',
      retry: { maximumAttempts: 3 },
    } as const;
    const inputError = await t.throwsAsync(
      t.context.env.client.activity.execute('payloadValidationActivity', {
        ...options,
        id: randomUUID(),
        args: [invalid('standalone-activity-input')],
      }),
      { instanceOf: ActivityExecutionFailedError }
    );
    assertPve(inputError?.cause);
    t.is(inputInvocations, 0);

    const result = await t.context.env.client.activity.execute<any>('payloadValidationActivity', {
      ...options,
      id: randomUUID(),
      args: [{ id: randomUUID() }],
    });
    t.is(result.attempt, 2);
  });
});
