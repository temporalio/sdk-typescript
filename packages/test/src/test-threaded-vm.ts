import { EventEmitter } from 'node:events';
import test from 'ava';
import { DefaultLogger, Runtime } from '@temporalio/worker';
import { compileWorkerOptions } from '@temporalio/worker/lib/worker-options';
import { WorkerThreadClient } from '@temporalio/worker/lib/workflow/threaded-vm';
import { WorkflowThreadLostError } from '@temporalio/worker/lib/workflow/threaded-vm-errors';
import type {
  WorkflowCreateOptions,
  WorkflowCreator,
  WorkflowThreadEvictionEvent,
} from '@temporalio/worker/lib/workflow/interface';
import { defaultOptions, Worker as MockWorker } from './mock-native-worker';

class FakeWorkerThread extends EventEmitter {
  public terminateCount = 0;

  postMessage(): void {
    // Responses are emitted explicitly by each test.
  }

  async terminate(): Promise<number> {
    this.terminateCount++;
    return 1;
  }
}

function workflowOptions(runId: string): WorkflowCreateOptions {
  return { info: { runId } } as WorkflowCreateOptions;
}

test('WorkerThreadClient tracks proactive local evictions', async (t) => {
  const workerThread = new FakeWorkerThread();
  const notifications: string[][] = [];
  const client = new WorkerThreadClient(workerThread as never, new DefaultLogger('ERROR'), undefined, ({ runIds }) =>
    notifications.push(runIds)
  );

  const created = client.send({ type: 'create-workflow', options: workflowOptions('run-1') });
  workerThread.emit('message', { requestId: 0n, result: { type: 'ok' } });
  await created;
  t.is(client.getActiveWorkflowCount(), 1);

  workerThread.emit('message', {
    type: 'workflow-evictions',
    runIds: ['run-1'],
    usedHeapSize: 800,
    heapSizeLimit: 1000,
  });
  t.is(client.getActiveWorkflowCount(), 0);
  t.deepEqual(notifications, [['run-1']]);
});

test('WorkerThreadClient reports owned runs and rejects pending work when its thread exits', async (t) => {
  const workerThread = new FakeWorkerThread();
  let lostRunIds: string[] | undefined;
  const client = new WorkerThreadClient(
    workerThread as never,
    new DefaultLogger('ERROR'),
    undefined,
    undefined,
    (_client, runIds) => {
      lostRunIds = runIds;
    }
  );

  const created = client.send({ type: 'create-workflow', options: workflowOptions('run-1') });
  workerThread.emit('exit', 1);

  await t.throwsAsync(created, { instanceOf: WorkflowThreadLostError });
  t.deepEqual(lostRunIds, ['run-1']);
  t.is(client.getActiveWorkflowCount(), 0);
});

test('WorkerThreadClient includes a create request that races with thread exit', async (t) => {
  const workerThread = new FakeWorkerThread();
  let lostRunIds: string[] | undefined;
  const client = new WorkerThreadClient(
    workerThread as never,
    new DefaultLogger('ERROR'),
    undefined,
    undefined,
    (_client, runIds) => {
      lostRunIds = runIds;
    }
  );

  workerThread.emit('error', new Error('simulated thread failure'));
  await t.throwsAsync(client.send({ type: 'create-workflow', options: workflowOptions('racing-run') }), {
    instanceOf: WorkflowThreadLostError,
  });
  workerThread.emit('exit', 1);

  t.deepEqual(lostRunIds, ['racing-run']);
});

test('WorkerThreadClient replaces a thread when heap-pressure disposal fails', async (t) => {
  const workerThread = new FakeWorkerThread();
  let lostRunIds: string[] | undefined;
  const lifecycleOrder: string[] = [];
  const client = new WorkerThreadClient(
    workerThread as never,
    new DefaultLogger('ERROR'),
    undefined,
    undefined,
    (_client, runIds) => {
      lifecycleOrder.push('eviction-requested');
      lostRunIds = runIds;
    }
  );

  let created = client.send({ type: 'create-workflow', options: workflowOptions('run-1') });
  workerThread.emit('message', { requestId: 0n, result: { type: 'ok' } });
  await created;
  created = client.send({ type: 'create-workflow', options: workflowOptions('run-2') });
  workerThread.emit('message', { requestId: 1n, result: { type: 'ok' } });
  await created;

  const idle = client.send({ type: 'mark-workflow-idle', runId: 'run-1' }).catch((error) => {
    lifecycleOrder.push('activation-rejected');
    throw error;
  });
  workerThread.emit('message', {
    requestId: 2n,
    result: {
      type: 'error',
      name: 'WorkflowThreadDisposalError',
      message: 'Failed to dispose Workflow run-1 under heap pressure',
    },
  });
  t.is(workerThread.terminateCount, 1);

  workerThread.emit('exit', 1);
  await t.throwsAsync(idle, { instanceOf: WorkflowThreadLostError });
  t.deepEqual(lostRunIds, ['run-1', 'run-2']);
  t.deepEqual(lifecycleOrder, ['eviction-requested', 'activation-rejected']);
});

test('Worker forwards language-side eviction requests to Core', (t) => {
  let evictionHandler: ((event: WorkflowThreadEvictionEvent) => void) | undefined;
  const workflowCreator: WorkflowCreator = {
    async createWorkflow() {
      throw new Error('not implemented');
    },
    async destroy() {},
    setLifecycleHandlers(handler) {
      evictionHandler = handler;
    },
  };
  const runtime = Runtime.instance();
  const worker = new MockWorker(
    workflowCreator,
    compileWorkerOptions(defaultOptions, runtime.logger, runtime.metricMeter)
  );

  evictionHandler!({ runIds: ['run-1', 'run-2'], reason: 'heap-pressure' });

  t.deepEqual(worker.native.requestedWorkflowEvictions, ['run-1', 'run-2']);
});
