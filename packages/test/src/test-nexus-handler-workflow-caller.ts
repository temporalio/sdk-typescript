import { randomUUID } from 'crypto';
import * as nexus from 'nexus-rpc';
import * as root from '@temporalio/proto';
import { ApplicationFailure, CancelledFailure, NexusOperationFailure, SdkComponent } from '@temporalio/common';
import { WorkflowFailedError } from '@temporalio/client';
import { LogEntry } from '@temporalio/worker';
import * as temporalnexus from '@temporalio/nexus';
import * as workflow from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';
import { waitUntil } from './helpers';

const recordedLogs: { [key: string]: LogEntry[] } = {};
const test = makeTestFunction({ workflowsPath: __filename, recordedLogs });

////////////////////////////////////////////////////////////////////////////////////////////////////
// Service definitions

const syncOpService = nexus.service('testService', {
  testSyncOp: nexus.operation<string, string>(),
});

const blockingOpService = nexus.service('blockingService', {
  blockingOp: nexus.operation<void, void>(),
});

const errorOpService = nexus.service('errorService', {
  op: nexus.operation<string, string>(),
});

const asyncOpService = nexus.service('asyncService', {
  asyncOp: nexus.operation<string, string>(),
});

const loggerService = nexus.service('loggerTestService', {
  loggerOp: nexus.operation<string, string>(),
});

const getClientService = nexus.service('getClientTestService', {
  getClientOp: nexus.operation<void, boolean>(),
});

const operationInfoService = nexus.service('operationInfoTestService', {
  operationInfoOp: nexus.operation<void, { namespace: string; taskQueue: string }>(),
});

const cancelErrorService = nexus.service('cancelErrorService', {
  cancelThrowsAppFailure: nexus.operation<void, void>(),
  cancelThrowsHandlerError: nexus.operation<void, void>(),
});

const linkCallbackService = nexus.service('linkCallbackService', {
  startTargetWorkflow: nexus.operation<void, void>(),
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// Caller workflows

export async function syncOpCaller(endpoint: string): Promise<string> {
  const client = workflow.createNexusClient({ endpoint, service: syncOpService });
  return await client.executeOperation('testSyncOp', 'hello');
}

export async function cancelSyncOpCaller(endpoint: string): Promise<void> {
  const client = workflow.createNexusClient({ endpoint, service: blockingOpService });
  return await client.executeOperation('blockingOp', undefined, {
    cancellationType: 'TRY_CANCEL',
  });
}

export async function errorOpCaller(endpoint: string, outcome: string): Promise<string> {
  const client = workflow.createNexusClient({ endpoint, service: errorOpService });
  return await client.executeOperation('op', outcome);
}

export async function asyncOpCaller(endpoint: string): Promise<string> {
  const client = workflow.createNexusClient({ endpoint, service: asyncOpService });
  return await client.executeOperation('asyncOp', 'hello');
}

export async function loggerOpCaller(endpoint: string): Promise<string> {
  const client = workflow.createNexusClient({ endpoint, service: loggerService });
  return await client.executeOperation('loggerOp', 'hello');
}

export async function getClientCaller(endpoint: string): Promise<boolean> {
  const client = workflow.createNexusClient({ endpoint, service: getClientService });
  return await client.executeOperation('getClientOp', undefined);
}

export async function operationInfoCaller(endpoint: string): Promise<{ namespace: string; taskQueue: string }> {
  const client = workflow.createNexusClient({ endpoint, service: operationInfoService });
  return await client.executeOperation('operationInfoOp', undefined);
}

export async function linkCallbackCaller(endpoint: string): Promise<void> {
  const client = workflow.createNexusClient({ endpoint, service: linkCallbackService });
  return await client.executeOperation('startTargetWorkflow', undefined);
}

export async function cancelAppFailureCaller(endpoint: string): Promise<void> {
  const client = workflow.createNexusClient({ endpoint, service: cancelErrorService });
  try {
    await client.executeOperation('cancelThrowsAppFailure', undefined, {
      cancellationType: 'WAIT_CANCELLATION_REQUESTED',
    });
  } catch (err) {
    if (workflow.isCancellation(err)) return;
    throw err;
  }
}

export async function cancelHandlerErrorCaller(endpoint: string): Promise<void> {
  const client = workflow.createNexusClient({ endpoint, service: cancelErrorService });
  try {
    await client.executeOperation('cancelThrowsHandlerError', undefined, {
      cancellationType: 'WAIT_CANCELLATION_REQUESTED',
    });
  } catch (err) {
    if (workflow.isCancellation(err)) return;
    throw err;
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Target workflows

export async function echoWorkflow(input: string): Promise<string> {
  return input;
}

export async function blockingTargetWorkflow(): Promise<void> {
  await workflow.condition(() => false);
}

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
      async () =>
        !!(await callerHandle.fetchHistory()).events?.some((ev) => ev.nexusOperationScheduledEventAttributes),
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
      t.true(
        err instanceof WorkflowFailedError &&
        err.cause instanceof NexusOperationFailure &&
        err.cause.cause instanceof nexus.HandlerError &&
        err.cause.cause.type === 'INTERNAL'
      );
      // Navigate past the optional server-added HandlerError wrapper to find the ApplicationFailure
      const outerHandler =
        err instanceof WorkflowFailedError &&
          err.cause instanceof NexusOperationFailure &&
          err.cause.cause instanceof nexus.HandlerError
          ? err.cause.cause
          : undefined;
      const appFailure =
        outerHandler?.cause instanceof nexus.HandlerError
          ? outerHandler.cause.cause // old server: skip extra HandlerError wrapper
          : outerHandler?.cause; // new server: ApplicationFailure is direct cause
      t.true(appFailure instanceof ApplicationFailure);
      if (appFailure instanceof ApplicationFailure) {
        t.is(appFailure.message, 'deliberate failure');
        t.deepEqual(appFailure.details, ['details']);
      }
    }

    // NonRetryableInternalHandlerError:
    // Older servers: NexusOperationFailure > HandlerError(INTERNAL) > HandlerError(INTERNAL)
    // Newer servers: NexusOperationFailure > HandlerError(INTERNAL)
    {
      const err = await t.throwsAsync(
        () => executeWorkflow(errorOpCaller, { args: [endpointName, 'NonRetryableInternalHandlerError'] }),
        { instanceOf: WorkflowFailedError }
      );
      t.true(
        err instanceof WorkflowFailedError &&
        err.cause instanceof NexusOperationFailure &&
        err.cause.cause instanceof nexus.HandlerError &&
        err.cause.cause.type === 'INTERNAL'
      );
      // The original error message should be present at some level of the HandlerError chain
      if (
        err instanceof WorkflowFailedError &&
        err.cause instanceof NexusOperationFailure &&
        err.cause.cause instanceof nexus.HandlerError
      ) {
        const handler = err.cause.cause;
        if (handler.cause instanceof nexus.HandlerError) {
          // Old server: message is on the inner HandlerError
          t.is(handler.cause.message, 'deliberate error');
        } else {
          // New server: message is on the HandlerError itself
          t.is(handler.message, 'deliberate error');
        }
      }
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
        async () =>
          !!(await callerHandle.fetchHistory()).events?.some((ev) => ev.nexusOperationStartedEventAttributes),
        4000
      );
      await callerHandle.cancel();
      const err = await t.throwsAsync(callerHandle.result(), {
        instanceOf: WorkflowFailedError,
      });
      t.true(
        err instanceof WorkflowFailedError &&
        err.cause instanceof NexusOperationFailure &&
        err.cause.cause instanceof nexus.HandlerError
      );
      // Navigate to find the ApplicationFailure in the cause chain
      if (
        err instanceof WorkflowFailedError &&
        err.cause instanceof NexusOperationFailure &&
        err.cause.cause instanceof nexus.HandlerError
      ) {
        const handler = err.cause.cause;
        const appFailure =
          handler.cause instanceof nexus.HandlerError ? handler.cause.cause : handler.cause;
        t.true(appFailure instanceof ApplicationFailure);
        if (appFailure instanceof ApplicationFailure) {
          t.is(appFailure.message, 'deliberate failure');
          t.deepEqual(appFailure.details, ['details']);
        }
      }
    }

    // NonRetryableInternalHandlerError from cancel handler
    {
      const callerHandle = await startWorkflow(cancelHandlerErrorCaller, {
        args: [endpointName],
      });
      await waitUntil(
        async () =>
          !!(await callerHandle.fetchHistory()).events?.some((ev) => ev.nexusOperationStartedEventAttributes),
        4000
      );
      await callerHandle.cancel();
      const err = await t.throwsAsync(callerHandle.result(), {
        instanceOf: WorkflowFailedError,
      });
      t.true(
        err instanceof WorkflowFailedError &&
        err.cause instanceof NexusOperationFailure &&
        err.cause.cause instanceof nexus.HandlerError &&
        err.cause.cause.type === 'INTERNAL'
      );
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
          const systemInfo = await temporalnexus
            .getClient()
            .connection.workflowService.getSystemInfo({ namespace: 'default' });
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
      async () =>
        !!(await callerHandle.fetchHistory()).events?.some((ev) => ev.nexusOperationStartedEventAttributes),
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
