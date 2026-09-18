import assert from 'assert';
import { randomUUID } from 'crypto';
import * as nexus from 'nexus-rpc';
import * as root from '@temporalio/proto';
import { ApplicationFailure, CancelledFailure, NexusOperationFailure, SdkComponent } from '@temporalio/common';
import { WorkflowFailedError } from '@temporalio/client';
import type { LogEntry } from '@temporalio/worker';
import * as temporalnexus from '@temporalio/nexus';
import * as workflow from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';
import { unwrapHandlerErrorCause, innermostHandlerError } from './helpers-nexus';
import { waitUntil } from './helpers';
import {
  assertOrder,
  assertReceipt,
  Order,
  orderTypeInfo,
  Receipt,
  receiptTypeInfo,
} from './workflows/type-info/models';
import { workflowWithTypeInfo } from './workflows/type-info/workflows';
import {
  InputA,
  InputB,
  asyncOpCaller,
  asyncOpService,
  blockingOpService,
  blockingTargetWorkflow,
  callNonExistentService,
  cancelAppFailureCaller,
  cancelErrorService,
  cancelHandlerErrorCaller,
  cancelSyncOpCaller,
  clientOperationTypeSafetyCheckerWorkflow,
  echoWorkflow,
  errorOpCaller,
  errorOpService,
  getClientCaller,
  getClientService,
  interceptorTypeInfoCaller,
  linkCallbackCaller,
  linkCallbackService,
  loggerOpCaller,
  loggerService,
  multiOpCaller,
  multiOpHandler,
  multiOpService,
  operationInfoCaller,
  operationInfoService,
  requestDeadlineCancelCaller,
  requestDeadlineService,
  requestDeadlineStartCaller,
  syncOpCaller,
  syncOpService,
  typeInfoCaller,
  typeInfoService,
} from './workflows/nexus-workflow-caller';

export { workflowWithTypeInfo };

const recordedLogs: { [key: string]: LogEntry[] } = {};
const test = makeTestFunction({
  recordedLogs,
  workflowInterceptorModules: [require.resolve('./workflows/type-info/nexus-interceptors')],
});

workflow.defineWorkflowOptions(typeInfoCaller, {
  staticOptions: { typeInfo: { outputType: receiptTypeInfo } },
});

workflow.defineWorkflowOptions(interceptorTypeInfoCaller, {
  staticOptions: { typeInfo: { outputType: receiptTypeInfo } },
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// Tests

test('sync Operation Handler happy path - caller workflow', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(syncOpService, {
        async testSyncOp(_ctx, input) {
          return input; // echo
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(syncOpCaller, {
      args: [endpointName],
    });
    t.is(result, 'hello');
  });
});

test('Nexus TypeInfo hydrates synchronous handler input and caller result', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(typeInfoService, {
        async convert(_ctx, input) {
          assertOrder(input);
          return new Receipt(input.id, input.totalCents + 1n);
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(typeInfoCaller, {
      args: [endpointName, true],
    });
    assertReceipt(result);
    t.is(result.summary(), 'order-1:124');
  });
});

test('Nexus TypeInfo hydrates asynchronous backing Workflow input and caller result', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(typeInfoService, {
        convert: new temporalnexus.WorkflowRunOperationHandler<Order, Receipt>(async (ctx, input) => {
          return await temporalnexus.startWorkflow(ctx, workflowWithTypeInfo, {
            workflowId: randomUUID(),
            args: [input],
          });
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(typeInfoCaller, { args: [endpointName, false] });
    assertReceipt(result);
    t.is(result.summary(), 'order-1:123');
  });
});

test('Workflow Nexus interceptor can supply operation TypeInfo', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(typeInfoService, {
        async convert(_ctx, input) {
          assertOrder(input);
          return new Receipt(input.id, input.totalCents + 1n);
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(interceptorTypeInfoCaller, { args: [endpointName] });
    assertReceipt(result);
    t.is(result.summary(), 'order-1:124');
  });
});

test('Operation Handler cancellation via workflow cancel', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  let abortPromise: Promise<never> | undefined;

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(blockingOpService, {
        async blockingOp(ctx) {
          abortPromise = new Promise<never>((_, reject) => {
            ctx.abortSignal.onabort = () => reject(ctx.abortSignal.reason);
          });
          return await abortPromise;
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const callerHandle = await startWorkflow(cancelSyncOpCaller, {
      args: [endpointName],
    });

    // Wait for the Nexus Operation to be scheduled (sync ops that block forever
    // never emit a NexusOperationStartedEvent, so we wait for scheduled instead).
    await waitUntil(
      async () => !!(await callerHandle.fetchHistory()).events?.some((ev) => ev.nexusOperationScheduledEventAttributes),
      4000
    );
    // Give the worker time to pick up and start executing the blocking handler.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // ...and then cancel the caller workflow
    await callerHandle.cancel();

    const err = await t.throwsAsync(callerHandle.result(), {
      instanceOf: WorkflowFailedError,
    });

    if (!(err?.cause instanceof CancelledFailure)) {
      return t.fail(`Expected CancelledFailure, got: ${err?.cause}`);
    }

    // Verify the abort signal actually fired and rejected the handler's promise.
    t.truthy(abortPromise);
    await t.throwsAsync(abortPromise!, { instanceOf: CancelledFailure });
  });
});

test('async Operation Handler happy path via WorkflowRunOperationHandler', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(asyncOpService, {
        asyncOp: new temporalnexus.WorkflowRunOperationHandler<string, string>(async (ctx, input) => {
          return await temporalnexus.startWorkflow(ctx, echoWorkflow, {
            workflowId: randomUUID(),
            args: [input],
          });
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(asyncOpCaller, {
      args: [endpointName],
    });
    t.is(result, 'hello');
  });
});

test('start Operation Handler errors - caller workflow', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(errorOpService, {
        async op(_ctx, outcome) {
          switch (outcome) {
            case 'NonRetryableApplicationFailure':
              throw ApplicationFailure.create({
                nonRetryable: true,
                message: 'deliberate failure',
                details: ['details'],
              });
            case 'NonRetryableInternalHandlerError':
              throw new nexus.HandlerError('INTERNAL', 'deliberate error', { retryableOverride: false });
            case 'OperationError':
              throw new nexus.OperationError('failed', 'deliberate error');
          }
          throw new nexus.HandlerError('BAD_REQUEST', 'invalid outcome requested');
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    // NonRetryableApplicationFailure:
    // Older servers add an extra HandlerError wrapper:
    //   NexusOperationFailure > HandlerError(INTERNAL) > HandlerError(INTERNAL) > ApplicationFailure
    // Newer servers do not:
    //   NexusOperationFailure > HandlerError(INTERNAL) > ApplicationFailure
    {
      const err = await t.throwsAsync(
        () => executeWorkflow(errorOpCaller, { args: [endpointName, 'NonRetryableApplicationFailure'] }),
        { instanceOf: WorkflowFailedError }
      );
      assert(err instanceof WorkflowFailedError);
      assert(err.cause instanceof NexusOperationFailure);
      assert(err.cause.cause instanceof nexus.HandlerError);
      t.is(err.cause.cause.type, 'INTERNAL');
      const appFailure = unwrapHandlerErrorCause(err.cause.cause);
      assert(appFailure instanceof ApplicationFailure);
      t.is(appFailure.message, 'deliberate failure');
      t.deepEqual(appFailure.details, ['details']);
    }

    // NonRetryableInternalHandlerError:
    // Older servers: NexusOperationFailure > HandlerError(INTERNAL) > HandlerError(INTERNAL)
    // Newer servers: NexusOperationFailure > HandlerError(INTERNAL)
    {
      const err = await t.throwsAsync(
        () => executeWorkflow(errorOpCaller, { args: [endpointName, 'NonRetryableInternalHandlerError'] }),
        { instanceOf: WorkflowFailedError }
      );
      assert(err instanceof WorkflowFailedError);
      assert(err.cause instanceof NexusOperationFailure);
      assert(err.cause.cause instanceof nexus.HandlerError);
      t.is(err.cause.cause.type, 'INTERNAL');
      const inner = innermostHandlerError(err.cause.cause);
      t.is(inner.message, 'deliberate error');
    }

    // OperationError: NexusOperationFailure > ApplicationFailure(type='OperationError')
    // (same on both old and new servers)
    {
      const err = await t.throwsAsync(
        () => executeWorkflow(errorOpCaller, { args: [endpointName, 'OperationError'] }),
        { instanceOf: WorkflowFailedError }
      );
      t.true(
        err instanceof WorkflowFailedError &&
          err.cause instanceof NexusOperationFailure &&
          err.cause.cause instanceof ApplicationFailure &&
          (err.cause.cause as ApplicationFailure).type === 'OperationError'
      );
    }
  });
});

test('cancel Operation Handler errors - caller workflow', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const cancelStartHandler = new temporalnexus.WorkflowRunOperationHandler<void, void>(async (ctx) => {
    return await temporalnexus.startWorkflow(ctx, blockingTargetWorkflow, {
      workflowId: randomUUID(),
    });
  });

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(cancelErrorService, {
        cancelThrowsAppFailure: {
          start: cancelStartHandler.start.bind(cancelStartHandler),
          cancel: async () => {
            throw ApplicationFailure.create({
              nonRetryable: true,
              message: 'deliberate failure',
              details: ['details'],
            });
          },
        },
        cancelThrowsHandlerError: {
          start: cancelStartHandler.start.bind(cancelStartHandler),
          cancel: async () => {
            throw new nexus.HandlerError('INTERNAL', 'deliberate error', { retryableOverride: false });
          },
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    // NonRetryableApplicationFailure from cancel handler
    {
      const callerHandle = await startWorkflow(cancelAppFailureCaller, {
        args: [endpointName],
      });
      await waitUntil(
        async () => !!(await callerHandle.fetchHistory()).events?.some((ev) => ev.nexusOperationStartedEventAttributes),
        4000
      );
      await callerHandle.cancel();
      const err = await t.throwsAsync(callerHandle.result(), {
        instanceOf: WorkflowFailedError,
      });
      assert(err instanceof WorkflowFailedError);
      assert(err.cause instanceof NexusOperationFailure);
      assert(err.cause.cause instanceof nexus.HandlerError);
      const appFailure = unwrapHandlerErrorCause(err.cause.cause);
      assert(appFailure instanceof ApplicationFailure);
      t.is(appFailure.message, 'deliberate failure');
      t.deepEqual(appFailure.details, ['details']);
    }

    // NonRetryableInternalHandlerError from cancel handler
    {
      const callerHandle = await startWorkflow(cancelHandlerErrorCaller, {
        args: [endpointName],
      });
      await waitUntil(
        async () => !!(await callerHandle.fetchHistory()).events?.some((ev) => ev.nexusOperationStartedEventAttributes),
        4000
      );
      await callerHandle.cancel();
      const err = await t.throwsAsync(callerHandle.result(), {
        instanceOf: WorkflowFailedError,
      });
      assert(err instanceof WorkflowFailedError);
      assert(err.cause instanceof NexusOperationFailure);
      assert(err.cause.cause instanceof nexus.HandlerError);
      t.is(err.cause.cause.type, 'INTERNAL');
    }
  });
});

test('logger is available in handler context - caller workflow', async (t) => {
  const h = helpers(t);
  const { createWorker, executeWorkflow, registerNexusEndpoint } = h;
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(loggerService, {
        async loggerOp(_ctx, input) {
          temporalnexus.log.info('handler ran', { input });
          return input;
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(loggerOpCaller, {
      args: [endpointName],
    });
    t.is(result, 'hello');
  });

  const allEntries = Object.values(recordedLogs).flat();
  const entries = allEntries.filter(
    ({ meta }) =>
      (meta as any)?.sdkComponent === SdkComponent.nexus &&
      (meta as any)?.service === 'loggerTestService' &&
      (meta as any)?.operation === 'loggerOp'
  );
  t.is(entries.length, 1);
  t.is(entries[0].message, 'handler ran');
  t.deepEqual(entries[0].meta, {
    sdkComponent: SdkComponent.nexus,
    namespace: t.context.env.namespace ?? 'default',
    service: 'loggerTestService',
    operation: 'loggerOp',
    taskQueue: h.taskQueue,
    input: 'hello',
  });
});

test('getClient is available in handler context - caller workflow', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(getClientService, {
        async getClientOp() {
          const systemInfo = await temporalnexus.getClient().connection.workflowService.getSystemInfo({});
          return systemInfo.capabilities?.nexus ?? false;
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(getClientCaller, {
      args: [endpointName],
    });
    t.is(result, true);
  });
});

test('operationInfo is available in handler context - caller workflow', async (t) => {
  const h = helpers(t);
  const { createWorker, executeWorkflow, registerNexusEndpoint } = h;
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(operationInfoService, {
        async operationInfoOp() {
          const info = temporalnexus.operationInfo();
          return {
            namespace: info.namespace,
            taskQueue: info.taskQueue,
            endpoint: info.endpoint,
          };
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(operationInfoCaller, {
      args: [endpointName],
    });
    t.is(result.namespace, 'default');
    t.is(result.taskQueue, h.taskQueue);
    t.is(result.endpoint, endpointName);
  });
});

test('WorkflowRunOperationHandler attaches links and callbacks - caller workflow', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const EventType = root.temporal.api.enums.v1.EventType;

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(linkCallbackService, {
        startTargetWorkflow: new temporalnexus.WorkflowRunOperationHandler<void, void>(async (ctx) => {
          return await temporalnexus.startWorkflow(ctx, blockingTargetWorkflow, {
            workflowId: randomUUID(),
          });
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const callerHandle = await startWorkflow(linkCallbackCaller, {
      args: [endpointName],
    });

    // Wait for the Nexus operation to start (i.e. the target workflow has been created).
    await waitUntil(
      async () => !!(await callerHandle.fetchHistory()).events?.some((ev) => ev.nexusOperationStartedEventAttributes),
      4000
    );

    const callerHistory = await callerHandle.fetchHistory();

    // --- Caller → Target links ---
    // The NexusOperationStartedEvent on the caller should have a link to the target workflow.
    const startedEvent = callerHistory.events!.find((ev) => ev.nexusOperationStartedEventAttributes)!;
    t.truthy(startedEvent.links?.length);
    const targetLink = startedEvent.links![0].workflowEvent;
    t.truthy(targetLink);
    t.truthy(targetLink!.workflowId);
    t.is(targetLink!.eventRef?.eventType, EventType.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED);

    // --- Target workflow metadata ---
    const targetHandle = t.context.env.client.workflow.getHandle(targetLink!.workflowId!);
    const targetDescription = await targetHandle.describe();

    // The server should have attached a callback so it can notify the caller when the target completes.
    t.truthy(targetDescription.raw.callbacks?.length);
    const callback = targetDescription.raw.callbacks![0].callback;
    t.truthy(callback?.nexus?.url);

    // The callback should have a link back to the caller's NexusOperationScheduled event.
    t.truthy(callback?.links?.length);
    const callerLink = callback!.links![0].workflowEvent;
    t.truthy(callerLink);
    t.is(callerLink!.workflowId, callerHandle.workflowId);
    t.is(callerLink!.eventRef?.eventType, EventType.EVENT_TYPE_NEXUS_OPERATION_SCHEDULED);
  });
});

test('Nexus sync and async Operations from a Workflow', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName, endpointIdentifier } = await registerNexusEndpoint();
  try {
    const worker = await createWorker({
      nexusServices: [
        nexus.serviceHandler(multiOpService, {
          async syncOp(_ctx, action) {
            if (action === 'pass') {
              return action;
            }
            if (action === 'throwHandlerError') {
              throw new nexus.HandlerError('INTERNAL', 'test asked to fail', { retryableOverride: false });
            }
            throw new nexus.HandlerError('BAD_REQUEST', 'invalid action');
          },
          asyncOp: new temporalnexus.WorkflowRunOperationHandler<string, string>(async (ctx, action) => {
            if (action === 'throwOperationError') {
              throw new nexus.OperationError('failed', 'some message');
            }
            if (action === 'throwApplicationFailure') {
              throw ApplicationFailure.create({
                nonRetryable: true,
                message: 'test asked to fail',
                type: 'IntentionalError',
                details: ['a detail'],
              });
            }
            return await temporalnexus.startWorkflow(ctx, multiOpHandler, {
              workflowId: randomUUID(),
              args: [action],
            });
          }),
        }),
      ],
    });
    await worker.runUntil(async () => {
      let res = await executeWorkflow(multiOpCaller, {
        args: [endpointName, 'syncOp', 'pass'],
      });
      t.is(res, 'pass');
      let err = await t.throwsAsync(
        () =>
          executeWorkflow(multiOpCaller, {
            args: [endpointName, 'syncOp', 'throwHandlerError'],
          }),
        {
          instanceOf: WorkflowFailedError,
        }
      );
      t.true(
        err instanceof WorkflowFailedError &&
          err.cause instanceof NexusOperationFailure &&
          err.cause.cause instanceof nexus.HandlerError &&
          err.cause.cause.type === 'INTERNAL'
      );

      res = await executeWorkflow(multiOpCaller, {
        args: [endpointName, 'asyncOp', 'pass'],
      });
      t.is(res, 'pass');
      err = await t.throwsAsync(
        () =>
          executeWorkflow(multiOpCaller, {
            args: [endpointName, 'asyncOp', 'waitForCancel'],
          }),
        {
          instanceOf: WorkflowFailedError,
        }
      );
      t.true(
        err instanceof WorkflowFailedError &&
          err.cause instanceof NexusOperationFailure &&
          err.cause.cause instanceof CancelledFailure
      );

      err = await t.throwsAsync(
        () =>
          executeWorkflow(multiOpCaller, {
            args: [endpointName, 'asyncOp', 'throwOperationError'],
          }),
        {
          instanceOf: WorkflowFailedError,
        }
      );
      t.true(
        err instanceof WorkflowFailedError &&
          err.cause instanceof NexusOperationFailure &&
          err.cause.cause instanceof ApplicationFailure
      );

      err = await t.throwsAsync(
        () =>
          executeWorkflow(multiOpCaller, {
            args: [endpointName, 'asyncOp', 'throwApplicationFailure'],
          }),
        {
          instanceOf: WorkflowFailedError,
        }
      );
      assert(err instanceof WorkflowFailedError);
      assert(err.cause instanceof NexusOperationFailure);
      assert(err.cause.cause instanceof nexus.HandlerError);
      t.is(err.cause.cause.type, 'INTERNAL');
      const appFailure = unwrapHandlerErrorCause(err.cause.cause);
      assert(appFailure instanceof ApplicationFailure);
      t.is(appFailure.message, 'test asked to fail');
      t.deepEqual(appFailure.details, ['a detail']);

      err = await t.throwsAsync(
        () =>
          executeWorkflow(multiOpCaller, {
            args: [endpointName, 'asyncOp', 'failWorkflow'],
          }),
        {
          instanceOf: WorkflowFailedError,
        }
      );
      t.true(
        err instanceof WorkflowFailedError &&
          err.cause instanceof NexusOperationFailure &&
          err.cause.cause instanceof ApplicationFailure &&
          err.cause.cause.message === 'test asked to fail' &&
          err.cause.cause.details?.length === 1 &&
          err.cause.cause.details[0] === 'a detail'
      );
    });
  } finally {
    await t.context.env.deleteNexusEndpoint(endpointIdentifier);
  }
});

test('calling a nonexistent service returns NOT_FOUND', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName, endpointIdentifier } = await registerNexusEndpoint();
  try {
    const worker = await createWorker({
      nexusServices: [
        nexus.serviceHandler(multiOpService, {
          async syncOp(_ctx, input) {
            return input;
          },
          asyncOp: {
            async start() {
              throw new Error('not implemented');
            },
            async cancel() {},
          },
        }),
      ],
    });
    await worker.runUntil(async () => {
      const err = await t.throwsAsync(
        () =>
          executeWorkflow(callNonExistentService, {
            args: [endpointName],
          }),
        {
          instanceOf: WorkflowFailedError,
        }
      );
      t.true(
        err instanceof WorkflowFailedError &&
          err.cause instanceof NexusOperationFailure &&
          err.cause.cause instanceof nexus.HandlerError &&
          err.cause.cause.type === 'NOT_FOUND'
      );
    });
  } finally {
    await t.context.env.deleteNexusEndpoint(endpointIdentifier);
  }
});

test('inbound startOperation interceptor can modify input and result', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName, endpointIdentifier } = await registerNexusEndpoint();
  try {
    const observedResults: nexus.HandlerStartOperationResult<unknown>[] = [];
    const worker = await createWorker({
      nexusServices: [
        nexus.serviceHandler(multiOpService, {
          async syncOp(_ctx, input) {
            return input;
          },
          asyncOp: new temporalnexus.WorkflowRunOperationHandler<string, string>(async (ctx, input) => {
            return await temporalnexus.startWorkflow(ctx, multiOpHandler, { workflowId: randomUUID(), args: [input] });
          }),
        }),
      ],
      interceptors: {
        nexus: [
          () => ({
            inbound: {
              async startOperation(input, next) {
                const output = await next({ ...input, input: input.input + ' modified' });
                const { result } = output;
                observedResults.push(result);
                if (!result.isAsync) {
                  return { result: nexus.HandlerStartOperationResult.sync(result.value + ' intercepted') };
                }
                return output;
              },
            },
          }),
        ],
      },
    });
    await worker.runUntil(async () => {
      const res = await executeWorkflow(multiOpCaller, {
        args: [endpointName, 'syncOp', 'hello'],
      });
      t.is(res, 'hello modified intercepted');
    });
    t.is(observedResults.length, 1);
    const result = observedResults[0];
    t.false(result.isAsync);
    if (!result.isAsync) {
      t.is(result.value, 'hello modified');
    }
  } finally {
    await t.context.env.deleteNexusEndpoint(endpointIdentifier);
  }
});

test('inbound cancelOperation interceptor can modify input', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName, endpointIdentifier } = await registerNexusEndpoint();
  try {
    const receivedTokens: string[] = [];
    const worker = await createWorker({
      nexusServices: [
        nexus.serviceHandler(multiOpService, {
          async syncOp(_ctx, input) {
            return input;
          },
          asyncOp: {
            async start(_ctx, _input) {
              return nexus.HandlerStartOperationResult.async('original-token');
            },
            async cancel(_ctx, token) {
              receivedTokens.push(token);
            },
          },
        }),
      ],
      interceptors: {
        nexus: [
          () => ({
            inbound: {
              async cancelOperation(input, next) {
                return await next({ ...input, token: input.token + '-modified' });
              },
            },
          }),
        ],
      },
    });
    await worker.runUntil(async () => {
      const err = await t.throwsAsync(
        () =>
          executeWorkflow(multiOpCaller, {
            args: [endpointName, 'asyncOp', 'waitForCancel', 'WAIT_CANCELLATION_REQUESTED'],
          }),
        {
          instanceOf: WorkflowFailedError,
        }
      );
      t.true(
        err instanceof WorkflowFailedError &&
          err.cause instanceof NexusOperationFailure &&
          err.cause.cause instanceof CancelledFailure
      );
    });
    t.is(receivedTokens.length, 1);
    t.is(receivedTokens[0], 'original-token-modified');
  } finally {
    await t.context.env.deleteNexusEndpoint(endpointIdentifier);
  }
});

test('NexusServiceClient is type-safe in regard to Operation Definitions', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName, endpointIdentifier } = await registerNexusEndpoint();
  try {
    // We intentionally use different property names here, to assert that the client side sent the
    // correct op name to the server (i.e. the operation's name, not the operation property name).
    const typeSafetyHandlerService = nexus.service('typeSafetyService', {
      implicitImpl: nexus.operation<InputA, InputA>({ name: 'implicit' }),
      explicitImpl: nexus.operation<InputB, InputB>({ name: 'my-custom-operation-name' }),
    });

    const worker = await createWorker({
      nexusServices: [
        nexus.serviceHandler(typeSafetyHandlerService, {
          implicitImpl: async (_ctx, input) => input,
          explicitImpl: async (_ctx, input) => input,
        }),
      ],
    });
    await worker.runUntil(async () => {
      await executeWorkflow(clientOperationTypeSafetyCheckerWorkflow, {
        args: [endpointName],
      });
    });

    // Most of the checks here would be exposed as compile-time errors,
    // and `executeWorkflow` will have thrown if any runtime error.
    t.pass();
  } finally {
    await t.context.env.deleteNexusEndpoint(endpointIdentifier);
  }
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// requestDeadline tests

test('requestDeadline is available in start operation context', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(requestDeadlineService, {
        checkDeadlineOnStart: async (ctx) => {
          return ctx.requestDeadline instanceof Date && !isNaN(ctx.requestDeadline.getTime());
        },
        checkDeadlineOnCancel: {
          async start() {
            return nexus.HandlerStartOperationResult.async('fake-token');
          },
          async cancel() {
            // no-op
          },
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(requestDeadlineStartCaller, {
      args: [endpointName],
    });
    t.true(result);
  });
});

test('requestDeadline is available in cancel operation context', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  let cancelDeadlineIsValid = false;

  const cancelStartHandler = new temporalnexus.WorkflowRunOperationHandler<void, void>(async (ctx) => {
    return await temporalnexus.startWorkflow(ctx, blockingTargetWorkflow, {
      workflowId: randomUUID(),
    });
  });

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(requestDeadlineService, {
        async checkDeadlineOnStart() {
          return false;
        },
        checkDeadlineOnCancel: {
          start: cancelStartHandler.start.bind(cancelStartHandler),
          cancel: async (ctx) => {
            cancelDeadlineIsValid = ctx.requestDeadline instanceof Date && !isNaN(ctx.requestDeadline.getTime());
          },
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const callerHandle = await startWorkflow(requestDeadlineCancelCaller, {
      args: [endpointName],
    });
    await waitUntil(async () => {
      const { events } = await callerHandle.fetchHistory();
      return (events ?? []).some(
        (ev) => ev.nexusOperationStartedEventAttributes != null || ev.nexusOperationFailedEventAttributes != null
      );
    }, 10_000);
    await callerHandle.cancel();
    await callerHandle.result();
  });

  t.true(cancelDeadlineIsValid);
});
