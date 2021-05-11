import anyTest, { TestInterface } from 'ava';
import Long from 'long';
import { Subject } from 'rxjs';
import { first, take, toArray } from 'rxjs/operators';
import { v4 as uuid4 } from 'uuid';
import { errors } from '@temporalio/worker';
import { ActivationWithContext } from '@temporalio/worker/lib/worker';
import { coresdk } from '@temporalio/proto';
import { msToTs } from '@temporalio/workflow/lib/time';
import { Worker, makeDefaultWorker } from './mock-native-worker';

export interface Context {
  worker: Worker;
  feedbackSubject: Subject<ActivationWithContext>;
}

export const test = anyTest as TestInterface<Context>;

test.beforeEach(async (t) => {
  t.context = {
    worker: await makeDefaultWorker(),
    feedbackSubject: new Subject(),
  };
});

function makeStartWorkflowActivation(runId: string) {
  return {
    taskToken: new Uint8Array([0, 1, 2, 3]),
    runId,
    timestamp: msToTs(10),
    jobs: [
      coresdk.workflow_activation.WFActivationJob.create({
        startWorkflow: {
          workflowId: 'wfid',
          arguments: [],
          workflowType: 'sleep',
          randomnessSeed: new Long(3),
        },
      }),
    ],
  };
}

test('Worker handles WorkflowError in pollWorkflowActivation correctly', async (t) => {
  const { worker, feedbackSubject } = t.context;
  const p = worker.runWorkflows(feedbackSubject);
  const runId = uuid4();
  const [numInFlightActivations, numRunningWorkflowInstances] = await Promise.all([
    worker.numInFlightActivations$.pipe(take(5), toArray()).toPromise(),
    worker.numRunningWorkflowInstances$.pipe(take(3), toArray()).toPromise(),
    (async () => {
      await worker.native.runWorkflowActivation(makeStartWorkflowActivation(runId));
      worker.native.emitWorkflowError(new errors.WorkflowError('Something bad happened', runId, 'details'));
    })(),
  ]);
  t.deepEqual(numInFlightActivations, [0, 1, 0, 1, 0]);
  t.deepEqual(numRunningWorkflowInstances, [0, 1, 0]);
  worker.shutdown();
  // Catch the ShutdownError to avoid unhandled rejection
  await t.throwsAsync(() => worker.native.pollActivityTask(), { instanceOf: errors.ShutdownError });
  await p;
});

test('Worker handles WorkflowError in completeWorkflowActivation correctly', async (t) => {
  const { worker, feedbackSubject } = t.context;
  const p = worker.runWorkflows(feedbackSubject);
  const runId = uuid4();
  worker.native.completeWorkflowActivation = () => {
    return Promise.reject(new errors.WorkflowError('Something bad happened', runId, 'details'));
  };
  const promises = Promise.all([
    worker.numInFlightActivations$.pipe(take(3), toArray()).toPromise(),
    worker.numRunningWorkflowInstances$.pipe(take(3), toArray()).toPromise(),
    feedbackSubject.pipe(first()).toPromise(),
  ]);
  worker.native.emit({
    workflow: makeStartWorkflowActivation(runId),
  });
  const [numInFlightActivations, numRunningWorkflowInstances] = await promises;
  t.deepEqual(numInFlightActivations, [0, 1, 0]);
  t.deepEqual(numRunningWorkflowInstances, [0, 1, 0]);
  worker.shutdown();
  // Catch the ShutdownError to avoid unhandled rejection
  await t.throwsAsync(() => worker.native.pollActivityTask(), { instanceOf: errors.ShutdownError });
  await p;
});
