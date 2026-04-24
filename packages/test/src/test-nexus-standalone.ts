import { randomUUID } from 'crypto';
import * as nexus from 'nexus-rpc';
import {
  Client,
  NexusOperationAlreadyStartedError,
  NexusOperationFailureError,
  NexusOperationIdConflictPolicy,
  NexusOperationIdReusePolicy,
  type NexusClientInterceptor,
  type StartNexusOperationInput,
  type GetNexusOperationResultInput,
  type DescribeNexusOperationInput,
  type CancelNexusOperationInput,
  type TerminateNexusOperationInput,
  type ListNexusOperationsInput,
  type CountNexusOperationsInput,
} from '@temporalio/client';
import * as temporalnexus from '@temporalio/nexus';
import * as workflow from '@temporalio/workflow';
import { CancelledFailure, TerminatedFailure, ApplicationFailure, NexusOperationFailure } from '@temporalio/common';
import { helpers, makeTestFunction } from './helpers-integration';

const test = makeTestFunction({ workflowsPath: __filename });

export const unblockEcho = workflow.defineUpdate<void, []>('unblockEcho');

export async function blockingEcho(input: string): Promise<string> {
  let unblocked = false;

  workflow.setHandler(unblockEcho, () => {
    unblocked = true;
  });

  await workflow.condition(() => unblocked);

  return input;
}

const testService = nexus.service('testService', {
  echo: nexus.operation<string, { value: string }>(),
  fail: nexus.operation<'application' | 'handler', string>(),
  blockingAsync: nexus.operation<{ echo: string; wfId?: string }, string>(),
});

// Creates a test handler and a promise that can be used to wait until the workflow
// started by blockingAsync has been started.
function makeTestHandler() {
  let markWorkflowStarted: () => void;
  const workflowStarted = new Promise<void>((resolve) => {
    markWorkflowStarted = resolve;
  });
  return {
    workflowStarted,
    handler: nexus.serviceHandler(testService, {
      async echo(_ctx, input) {
        return { value: input };
      },
      async fail(_ctx, input) {
        switch (input) {
          case 'application':
            throw ApplicationFailure.create({
              message: 'test-application-failure',
              nonRetryable: true,
            });
          case 'handler':
            throw new nexus.HandlerError(nexus.HandlerErrorType.INTERNAL, 'test-error', { retryableOverride: false });
        }
      },
      blockingAsync: new temporalnexus.WorkflowRunOperationHandler<{ echo: string; wfId?: string }, string>(
        async (ctx, input) => {
          const handle = await temporalnexus.startWorkflow(ctx, blockingEcho, {
            workflowId: input.wfId ?? randomUUID(),
            args: [input.echo],
          });
          markWorkflowStarted();
          return handle;
        }
      ),
    }),
  };
}

test('start sync operation and get result', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { handler } = makeTestHandler();
  const worker = await createWorker({ nexusServices: [handler] });

  await worker.runUntil(async () => {
    const svc = t.context.env.client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const handle = await svc.startOperation(testService.operations.echo, 'hello', {
      id: 'op-' + randomUUID(),
      scheduleToCloseTimeout: '10s',
    });
    t.is(typeof handle.operationId, 'string');
    const result = await handle.result();
    t.is(result.value, 'hello');
  });
});

test('start async operation and poll result', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { handler, workflowStarted } = makeTestHandler();
  const worker = await createWorker({ nexusServices: [handler] });

  await worker.runUntil(async () => {
    const svc = t.context.env.client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const id = randomUUID();
    const handle = await svc.startOperation(
      testService.operations.blockingAsync,
      { echo: 'async-hello', wfId: id },
      {
        id: `op-${id}`,
        scheduleToCloseTimeout: '10s',
      }
    );

    // wait for workflow to start
    await workflowStarted;

    // unblock workflow
    const wfHandle = t.context.env.client.workflow.getHandle(id);
    await wfHandle.executeUpdate(unblockEcho);

    const result = await handle.result();
    t.is(result, 'async-hello');
  });
});

test('execute operation', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { handler } = makeTestHandler();
  const worker = await createWorker({ nexusServices: [handler] });

  await worker.runUntil(async () => {
    const svc = t.context.env.client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const result = await svc.executeOperation('echo', 'execute-test', {
      id: 'op-' + randomUUID(),
      scheduleToCloseTimeout: '10s',
    });
    t.is(result.value, 'execute-test');
  });
});

test('describe operation', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { handler } = makeTestHandler();
  const worker = await createWorker({ nexusServices: [handler] });

  await worker.runUntil(async () => {
    const svc = t.context.env.client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const handle = await svc.startOperation(testService.operations.echo, 'describe-test', {
      id: 'op-' + randomUUID(),
      scheduleToCloseTimeout: '10s',
      summary: 'test-summary',
    });
    const desc = await handle.describe();
    t.is(desc.operationId, handle.operationId);
    t.is(desc.endpoint, endpointName);
    t.is(desc.service, testService.name);
    t.is(desc.operation, 'echo');
    t.truthy(desc.scheduleTime);
    t.is(await desc.staticSummary(), 'test-summary');
  });
});

test('cancel operation', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { handler } = makeTestHandler();
  const worker = await createWorker({ nexusServices: [handler] });

  await worker.runUntil(async () => {
    const svc = t.context.env.client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const handle = await svc.startOperation(
      testService.operations.blockingAsync,
      { echo: 'cancel-test' },
      {
        id: 'op-' + randomUUID(),
        scheduleToCloseTimeout: '60s',
      }
    );
    await t.notThrowsAsync(handle.cancel('test cancellation'));
    const err = await t.throwsAsync(handle.result(), { instanceOf: NexusOperationFailureError });
    t.true(err?.cause instanceof CancelledFailure);
  });
});

test('terminate operation', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { handler } = makeTestHandler();
  const worker = await createWorker({ nexusServices: [handler] });

  await worker.runUntil(async () => {
    const svc = t.context.env.client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const handle = await svc.startOperation(
      testService.operations.blockingAsync,
      { echo: 'cancel-test' },
      {
        id: 'op-' + randomUUID(),
        scheduleToCloseTimeout: '60s',
      }
    );
    await t.notThrowsAsync(handle.terminate('test termination'));
    const err = await t.throwsAsync(handle.result(), { instanceOf: NexusOperationFailureError });
    t.true(err?.cause instanceof TerminatedFailure);
  });
});

test('list operations', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { handler } = makeTestHandler();
  const worker = await createWorker({ nexusServices: [handler] });

  await worker.runUntil(async () => {
    const { client } = t.context.env;
    const svc = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const opIds = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const id = 'list-op-' + randomUUID();
      await svc.startOperation(testService.operations.echo, `list-${i}`, {
        id,
        scheduleToCloseTimeout: '10s',
      });
      opIds.add(id);
    }
    const seen = new Set<string>();
    for await (const op of client.nexus.list({ query: `Endpoint="${endpointName}"` })) {
      seen.add(op.operationId);
      if (seen.size >= 3) break;
    }
    let intersection = 0;
    for (const id of opIds) if (seen.has(id)) intersection++;
    t.true(intersection >= 1, `expected at least 1 of ${opIds.size} operations in list, saw ${intersection}`);
  });
});

test('count operations', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { handler } = makeTestHandler();
  const worker = await createWorker({ nexusServices: [handler] });

  await worker.runUntil(async () => {
    const { client } = t.context.env;
    const svc = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    await svc.startOperation(testService.operations.echo, 'count-test', {
      id: 'count-op-' + randomUUID(),
      scheduleToCloseTimeout: '10s',
    });
    const result = await client.nexus.count(`Endpoint="${endpointName}"`);
    t.true(result.count >= 1);
  });
});

test('get handle by ID', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { handler } = makeTestHandler();
  const worker = await createWorker({ nexusServices: [handler] });

  await worker.runUntil(async () => {
    const { client } = t.context.env;
    const svc = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const id = 'handle-op-' + randomUUID();
    const handle1 = await svc.startOperation(testService.operations.echo, 'handle-test', {
      id,
      scheduleToCloseTimeout: '10s',
    });
    const handle2 = client.nexus.getHandle<typeof testService.operations.echo>(id, { runId: handle1.runId });
    const result = await handle2.result();
    t.is(result.value, 'handle-test');

    // test that result() caches the value
    const secondResult = await handle2.result();
    t.is(result, secondResult);
  });
});

test('ID conflict policy USE_EXISTING returns existing run', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { handler, workflowStarted } = makeTestHandler();
  const worker = await createWorker({ nexusServices: [handler] });

  await worker.runUntil(async () => {
    const svc = t.context.env.client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const id = 'conflict-op-' + randomUUID();
    const wfId = `${id}-wf`;
    const h1 = await svc.startOperation(
      testService.operations.blockingAsync,
      { echo: 'first', wfId },
      {
        id,
        scheduleToCloseTimeout: '60s',
      }
    );
    const h2 = await svc.startOperation(
      testService.operations.blockingAsync,
      { echo: 'first', wfId },
      {
        id,
        scheduleToCloseTimeout: '60s',
        idConflictPolicy: NexusOperationIdConflictPolicy.USE_EXISTING,
      }
    );
    t.is(h1.operationId, h2.operationId);
    t.is(h1.runId, h2.runId);

    // wait for workflow to start
    await workflowStarted;

    // unblock workflow
    const wfHandle = t.context.env.client.workflow.getHandle(wfId);
    await wfHandle.executeUpdate(unblockEcho);

    // get result from both handles
    const h1Result = await h1.result();
    const h2Result = await h2.result();

    t.is(h1Result, 'first');
    t.is(h1Result, h2Result);
  });
});

test('ID reuse policy REJECT_DUPLICATE after close throws AlreadyStartedError', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { handler } = makeTestHandler();
  const worker = await createWorker({ nexusServices: [handler] });

  await worker.runUntil(async () => {
    const svc = t.context.env.client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const id = 'reuse-op-' + randomUUID();
    const h1 = await svc.startOperation(testService.operations.echo, 'first', {
      id,
      scheduleToCloseTimeout: '10s',
    });
    await h1.result();
    await t.throwsAsync(
      svc.startOperation(testService.operations.echo, 'second', {
        id,
        scheduleToCloseTimeout: '10s',
        idReusePolicy: NexusOperationIdReusePolicy.REJECT_DUPLICATE,
      }),
      { instanceOf: NexusOperationAlreadyStartedError }
    );
  });
});

test('failure propagation', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { handler } = makeTestHandler();
  const worker = await createWorker({ nexusServices: [handler] });

  await worker.runUntil(async () => {
    const svc = t.context.env.client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const err = await t.throwsAsync(
      svc.executeOperation(testService.operations.fail, 'application', {
        id: 'fail-op-' + randomUUID(),
        scheduleToCloseTimeout: '10s',
      }),
      { instanceOf: NexusOperationFailureError }
    );
    t.true(err?.cause instanceof nexus.HandlerError);
    t.true(err?.cause.cause instanceof ApplicationFailure);

    const handle = await svc.startOperation(testService.operations.fail, 'handler', {
      id: 'fail-op-' + randomUUID(),
      scheduleToCloseTimeout: '10s',
    });
    const handleErr = await t.throwsAsync(handle.result(), { instanceOf: NexusOperationFailureError });
    t.true(handleErr?.cause instanceof nexus.HandlerError);

    // test that result() caches the failure
    const secondHandleErr = await t.throwsAsync(handle.result(), { instanceOf: NexusOperationFailureError });
    t.is(handleErr, secondHandleErr);
  });
});

test('interceptor integration', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { handler } = makeTestHandler();
  const worker = await createWorker({ nexusServices: [handler] });

  await worker.runUntil(async () => {
    const calls: string[] = [];
    const interceptor: NexusClientInterceptor = {
      async startOperation(input: StartNexusOperationInput, next) {
        calls.push('start');
        return await next(input);
      },
      async getResult(input: GetNexusOperationResultInput, next) {
        calls.push('getResult');
        return await next(input);
      },
      async describe(input: DescribeNexusOperationInput, next) {
        calls.push('describe');
        return await next(input);
      },
      async cancel(input: CancelNexusOperationInput, next) {
        calls.push('cancel');
        return await next(input);
      },
      async terminate(input: TerminateNexusOperationInput, next) {
        calls.push('terminate');
        return await next(input);
      },
      list(input: ListNexusOperationsInput, next) {
        calls.push('list');
        return next(input);
      },
      async count(input: CountNexusOperationsInput, next) {
        calls.push('count');
        return await next(input);
      },
    };

    const { env } = t.context;
    const client = new Client({
      connection: env.connection,
      namespace: env.namespace,
      interceptors: { nexus: [interceptor] },
    });
    const svc = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });

    const id = 'interceptor-op-' + randomUUID();
    const handle = await svc.startOperation(testService.operations.echo, 'hello', {
      id,
      scheduleToCloseTimeout: '10s',
    });
    await handle.result();
    await handle.describe();

    const handle2 = await svc.startOperation(
      testService.operations.blockingAsync,
      { echo: 'hello-2' },
      {
        id: 'interceptor-op2-' + randomUUID(),
        scheduleToCloseTimeout: '60s',
      }
    );
    await handle2.cancel('interceptor test');

    const handle3 = await svc.startOperation(
      testService.operations.blockingAsync,
      { echo: 'hello-2' },
      {
        id: 'interceptor-op3-' + randomUUID(),
        scheduleToCloseTimeout: '60s',
      }
    );
    await handle3.terminate('interceptor test');
    for await (const _ of client.nexus.list({ query: `Endpoint="${endpointName}"` })) break;
    await client.nexus.count(`Endpoint="${endpointName}"`);

    t.true(calls.includes('start'), 'start called');
    t.true(calls.includes('getResult'), 'getResult called');
    t.true(calls.includes('describe'), 'describe called');
    t.true(calls.includes('cancel'), 'cancel called');
    t.true(calls.includes('terminate'), 'terminate called');
    t.true(calls.includes('list'), 'list called');
    t.true(calls.includes('count'), 'count called');
  });
});
