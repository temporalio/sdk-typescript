import assert from 'assert';
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

////////////////////////////////////////////////////////////////////////////////////////////////////

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
  const endpointName = t.title.replaceAll(/[\s,]/g, '-') + '-' + randomUUID();
  const endpoint = await t.context.env.createNexusEndpoint(endpointName, taskQueue);
  t.teardown(() => t.context.env.deleteNexusEndpoint(endpoint));

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
      args: [endpointName, 'syncOp', 'pass'],
    });
    t.is(res, 'pass');
    let err = await t.throwsAsync(
      () =>
        executeWorkflow(caller, {
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

    res = await executeWorkflow(caller, {
      args: [endpointName, 'asyncOp', 'pass'],
    });
    t.is(res, 'pass');
    err = await t.throwsAsync(
      () =>
        executeWorkflow(caller, {
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
        executeWorkflow(caller, {
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
        executeWorkflow(caller, {
          args: [endpointName, 'asyncOp', 'throwApplicationFailure'],
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
});

////////////////////////////////////////////////////////////////////////////////////////////////////

type InputA = { a: string };
type InputB = { b: string };

const clientOperationTypeSafetyCheckerService = nexus.service('test', {
  implicit: nexus.operation<InputA, InputA>(),
  explicit: nexus.operation<InputB, InputB>({ name: 'my-custom-operation-name' }),
});

export async function clientOperationTypeSafetyCheckerWorkflow(endpoint: string): Promise<void> {
  const Service = clientOperationTypeSafetyCheckerService;
  const operations = Service.operations;
  const client = workflow.createNexusClient({
    endpoint,
    service: Service,
  });

  // That's quite exhaustive, but we can't generalize these without risking compromising
  // the validity of the compiler's type safety checks that we specifically want to test here.

  // Case 1: Provide resolved OperationDefinition object, with correct input type
  // There should be no compilation error, and it should execute successfully.
  {
    const wha = await client.startOperation(operations.implicit, { a: 'a' });
    assert(((await wha.result()) satisfies InputA).a === 'a');

    const whb = await client.startOperation(operations.explicit, { b: 'b' });
    assert(((await whb.result()) satisfies InputB).b === 'b');
  }

  // Case 2: Provide the operation _property name_, with correct input type
  //
  // The _property name_ is the name of the property used to specify the operation in the
  // `ServiceDefinition` object, which may differ from the value of the `name` property
  // if one was explicitly specified on the OperationDefinition object).
  // There should be no compilation error, and it should execute successfully.
  {
    const wha = await client.startOperation('implicit', { a: 'a' });
    assert(((await wha.result()) satisfies InputA).a === 'a');

    const whb = await client.startOperation('explicit', { b: 'b' });
    assert(((await whb.result()) satisfies InputB).b === 'b');
  }

  // Case 3: Provide resolved OperationDefinition object, with _incorrect_ input type.
  // Compiler should complain, and if forced to execute anyway, should result in a HandlerError.
  {
    // @ts-expect-error - Incompatible input type
    const wha = await client.startOperation(operations.implicit, { x: 'x' });
    assert(((await wha.result()) satisfies InputA as any).x === 'x');

    // @ts-expect-error - Incompatible input type
    const whb = await client.startOperation(operations.explicit, { x: 'x' });
    assert(((await whb.result()) satisfies InputB as any).x === 'x');
  }

  // Case 4: Provide the operation _property name_, with _incorrect_ input type.
  // Compiler should complain, and if forced to execute anyway, should result in a HandlerError.
  {
    // @ts-expect-error - Incompatible input type
    const wha = await client.startOperation(operations.implicit, { x: 'x' });
    assert(((await wha.result()) satisfies InputA as any).x === 'x');

    // @ts-expect-error - Incompatible input type
    const whb = await client.startOperation(operations.explicit, { x: 'x' });
    assert(((await whb.result()) satisfies InputB as any).x === 'x');
  }

  // Case 5: Non-existent operation name
  // Compiler should complain, and if forced to execute anyway, handler will throw a HandlerError.
  {
    try {
      // @ts-expect-error - Incorrect operation name
      await client.startOperation('non-existent', { x: 'x' });
    } catch (err) {
      assert(err instanceof NexusOperationFailure, `Expected a NexusOperationFailure, got ${err}`);
      assert(err.cause instanceof nexus.HandlerError, `Expected casue to be a HandlerError, got ${err.cause}`);
      assert(err.cause.type === 'NOT_FOUND', `Expected a NOT_FOUND error, got ${err.cause.type}`);
    }
  }
}

test('NexusClient is type-safe in regard to Operation Definitions', async (t) => {
  const { createWorker, executeWorkflow, taskQueue } = helpers(t);
  const endpointName = t.title.replaceAll(/[\s,]/g, '-') + '-' + randomUUID();
  const endpoint = await t.context.env.createNexusEndpoint(endpointName, taskQueue);
  t.teardown(() => t.context.env.deleteNexusEndpoint(endpoint));

  // We intentionally use different property names here, to assert that the client side sent the
  // correct op name to the server (i.e. the operation's name, not the operation property name).
  const clientOperationTypeSafetyCheckerService = nexus.service('test', {
    implicitImpl: nexus.operation<InputA, InputA>({ name: 'implicit' }),
    explicitImpl: nexus.operation<InputB, InputB>({ name: 'my-custom-operation-name' }),
  });

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(clientOperationTypeSafetyCheckerService, {
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
});
