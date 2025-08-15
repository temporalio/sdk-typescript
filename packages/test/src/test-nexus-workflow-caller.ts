import { randomUUID } from 'crypto';
import * as nexus from 'nexus-rpc';
import { ApplicationFailure, CancelledFailure, NexusOperationFailure } from '@temporalio/common';
import { WorkflowFailedError } from '@temporalio/client';
import * as temporalnexus from '@temporalio/nexus';
import * as workflow from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';

const service = nexus.service('test', {
  syncOp: nexus.operation<string, string>({ name: 'my-sync-op' }),
  asyncOp: nexus.operation<string, string>(),
});

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
});

export async function caller(endpoint: string, op: keyof typeof service.operations, action: string): Promise<string> {
  const client = workflow.createNexusClient({
    endpoint,
    service,
  });
  return await workflow.CancellationScope.cancellable(async () => {
    const handle = await client.startOperation(op, action);
    if (action === 'waitForCancel') {
      workflow.CancellationScope.current().cancel();
    }
    return await handle.result();
  });
}

export async function handler(action: string): Promise<string> {
  if (action === 'failWorkflow') {
    throw ApplicationFailure.create({
      nonRetryable: true,
      message: 'test asked to fail',
      type: 'IntentionalError',
      details: ['a detail'],
    });
  }
  if (action === 'waitForCancel') {
    await workflow.CancellationScope.current().cancelRequested;
  }
  return action;
}

test('Nexus Operation from a Workflow', async (t) => {
  const { createWorker, executeWorkflow, taskQueue } = helpers(t);
  const endpoint = t.title.replaceAll(/[\s,]/g, '-') + '-' + randomUUID();
  await t.context.env.connection.operatorService.createNexusEndpoint({
    spec: {
      name: endpoint,
      target: {
        worker: {
          namespace: 'default',
          taskQueue,
        },
      },
    },
  });
  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(service, {
        async syncOp(_ctx, action) {
          if (action === 'pass') {
            return action;
          }
          if (action === 'throwHandlerError') {
            throw new nexus.HandlerError('INTERNAL', 'test asked to fail', { retryableOverride: false });
          }
          throw new nexus.HandlerError('BAD_REQUEST', 'invalid action');
        },
        asyncOp: new temporalnexus.WorkflowRunOperation<string, string>(async (ctx, action) => {
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
          return await temporalnexus.startWorkflow(ctx, handler, {
            workflowId: randomUUID(),
            args: [action],
          });
        }),
      }),
    ],
  });
  await worker.runUntil(async () => {
    let res = await executeWorkflow(caller, {
      args: [endpoint, 'syncOp', 'pass'],
    });
    t.is(res, 'pass');
    let err = await t.throwsAsync(
      () =>
        executeWorkflow(caller, {
          args: [endpoint, 'syncOp', 'throwHandlerError'],
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

    res = await executeWorkflow(caller, {
      args: [endpoint, 'asyncOp', 'pass'],
    });
    t.is(res, 'pass');
    err = await t.throwsAsync(
      () =>
        executeWorkflow(caller, {
          args: [endpoint, 'asyncOp', 'waitForCancel'],
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
        executeWorkflow(caller, {
          args: [endpoint, 'asyncOp', 'throwOperationError'],
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
        executeWorkflow(caller, {
          args: [endpoint, 'asyncOp', 'throwApplicationFailure'],
        }),
      {
        instanceOf: WorkflowFailedError,
      }
    );
    t.true(
      err instanceof WorkflowFailedError &&
        err.cause instanceof NexusOperationFailure &&
        err.cause.cause instanceof nexus.HandlerError &&
        err.cause.cause.cause instanceof ApplicationFailure &&
        err.cause.cause.cause.message === 'test asked to fail' &&
        err.cause.cause.cause.details?.length === 1 &&
        err.cause.cause.cause.details[0] === 'a detail'
    );

    err = await t.throwsAsync(
      () =>
        executeWorkflow(caller, {
          args: [endpoint, 'asyncOp', 'failWorkflow'],
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
});
