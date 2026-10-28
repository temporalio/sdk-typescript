/**
 * Verifies that signals sent from a Temporal Nexus Operation handler carry the operation's request
 * ID, so that the server dedupes them when a Nexus task is redelivered, and that only one such
 * signal may be sent per handler invocation.
 */
import { randomUUID } from 'crypto';
import * as nexus from 'nexus-rpc';
import * as temporalnexus from '@temporalio/nexus';
import * as workflow from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowEnvironmentOpts: {
    server: {
      extraArgs: ['--dynamic-config-value', 'system.refreshNexusEndpointsMinWait="0s"'],
    },
  },
});

export const pingSignal = workflow.defineSignal<[string]>('ping');

/**
 * Target Workflow that the Nexus operation handlers signal. It collects `expectedSignals` ping
 * payloads and returns them joined.
 */
export async function callee(expectedSignals: number): Promise<string> {
  const received: string[] = [];
  workflow.setHandler(pingSignal, (msg: string) => {
    received.push(msg);
  });
  await workflow.condition(() => received.length >= expectedSignals);
  return received.join(',');
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Test: a second signal in one operation invocation is rejected

const doubleSignalService = nexus.service('doubleSignaling', {
  signalTwice: nexus.operation<{ workflowIds: [string, string] }, string>(),
});

export async function doubleSignalCaller(endpoint: string, calleeWorkflowIds: [string, string]): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: doubleSignalService });
  return await client.executeOperation('signalTwice', { workflowIds: calleeWorkflowIds });
}

function doubleSignalServiceHandler(taskQueue: string) {
  const handlers: nexus.ServiceHandlerFor<typeof doubleSignalService.operations> = {
    signalTwice: new temporalnexus.TemporalOperationHandler<{ workflowIds: [string, string] }, string>({
      async start(_ctx, client, input) {
        const [first, second] = input.workflowIds;
        await client.signalWithStartWorkflow<typeof callee, [string]>(callee, {
          workflowId: first,
          taskQueue,
          args: [1],
          signal: pingSignal,
          signalArgs: ['first'],
        });
        // The first signal uses up the invocation's only signal, so a second one is rejected even
        // though it targets a different workflow.
        try {
          await client.getWorkflowHandle(second).signal(pingSignal, 'second');
        } catch (err) {
          if (err instanceof nexus.HandlerError && err.type === 'BAD_REQUEST') {
            return temporalnexus.TemporalOperationResult.sync(err.message);
          }
          throw err;
        }
        throw new Error('expected the second signal to be rejected');
      },
    }),
  };
  return nexus.serviceHandler(doubleSignalService, handlers);
}

test('a second signal in one Nexus operation invocation is rejected', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint, taskQueue } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();
  const calleeId = `double-callee-${randomUUID()}`;

  const worker = await createWorker({
    nexusServices: [doubleSignalServiceHandler(taskQueue)],
  });

  await worker.runUntil(async () => {
    const callerHandle = await startWorkflow(doubleSignalCaller, {
      args: [endpointName, [calleeId, `${calleeId}-other`]],
    });
    t.regex(await callerHandle.result(), /Only one signal can be sent per operation handler invocation/);
    t.is(await client.workflow.getHandle(calleeId).result(), 'first');
  });
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// Test: a signal is deduped across Nexus handler retries

export const doneSignal = workflow.defineSignal('done');

/**
 * Returns how many pings reached the Workflow before `done`.
 */
export async function countPings(): Promise<number> {
  let count = 0;
  let done = false;
  workflow.setHandler(pingSignal, () => void count++);
  workflow.setHandler(doneSignal, () => void (done = true));
  await workflow.condition(() => done);
  return count;
}

const retrySignalService = nexus.service('retrySignaling', {
  signalWithStart: nexus.operation<{ workflowId: string }, string>(),
});

export async function retrySignalCaller(endpoint: string, calleeWorkflowId: string): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: retrySignalService });
  return await client.executeOperation('signalWithStart', { workflowId: calleeWorkflowId });
}

/**
 * Fails its first attempt after signaling, forcing the Nexus task to be redelivered. Both attempts
 * signal with the operation's request ID, so the server must dedupe the second one.
 */
function retrySignalServiceHandler(taskQueue: string, requestIds: string[]) {
  const handlers: nexus.ServiceHandlerFor<typeof retrySignalService.operations> = {
    signalWithStart: new temporalnexus.TemporalOperationHandler<{ workflowId: string }, string>({
      async start(ctx, client, input) {
        await client.signalWithStartWorkflow<typeof countPings, [string]>(countPings, {
          workflowId: input.workflowId,
          taskQueue,
          signal: pingSignal,
          signalArgs: ['ping'],
        });
        requestIds.push(ctx.requestId);
        if (requestIds.length === 1) {
          throw new nexus.HandlerError('INTERNAL', 'force handler redelivery after signaling', {
            retryableOverride: true,
          });
        }
        return temporalnexus.TemporalOperationResult.sync('ok');
      },
    }),
  };
  return nexus.serviceHandler(retrySignalService, handlers);
}

test('a signal from a Nexus operation is deduped across handler retries', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint, taskQueue } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();
  const calleeId = `retry-callee-${randomUUID()}`;
  const requestIds: string[] = [];

  const worker = await createWorker({
    nexusServices: [retrySignalServiceHandler(taskQueue, requestIds)],
  });

  await worker.runUntil(async () => {
    const callerHandle = await startWorkflow(retrySignalCaller, {
      args: [endpointName, calleeId],
    });
    t.is(await callerHandle.result(), 'ok');
    t.is(requestIds.length, 2, 'handler should fail once and then be redelivered once');
    t.is(requestIds[0], requestIds[1], 'Nexus request ID must remain stable across handler redelivery');

    const calleeHandle = client.workflow.getHandle(calleeId);
    await calleeHandle.signal(doneSignal);
    t.is(await calleeHandle.result(), 1, 'signal must be deduped on the request ID across handler redelivery');
  });
});
