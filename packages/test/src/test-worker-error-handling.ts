import anyTest, { TestInterface } from 'ava';
import Long from 'long';
import { BehaviorSubject, Subject } from 'rxjs';
import { first, take, tap, toArray } from 'rxjs/operators';
import { v4 as uuid4 } from 'uuid';
import { errors } from '@temporalio/worker';
import { coresdk } from '@temporalio/proto';
import { msToTs } from '@temporalio/workflow/commonjs/time';
import { Worker, makeDefaultWorker } from './mock-native-worker';

export interface Context {
  worker: Worker;
  feedbackSubject: Subject<coresdk.workflow_activation.WFActivation>;
  numInFlightActivationsSubject: BehaviorSubject<number>;
  numRunningWorkflowInstancesSubject: BehaviorSubject<number>;
}

export const test = anyTest as TestInterface<Context>;

test.beforeEach((t) => {
  t.context = {
    worker: makeDefaultWorker(),
    feedbackSubject: new Subject(),
    numInFlightActivationsSubject: new BehaviorSubject(0),
    numRunningWorkflowInstancesSubject: new BehaviorSubject(0),
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
  const { worker, feedbackSubject, numInFlightActivationsSubject, numRunningWorkflowInstancesSubject } = t.context;
  const p = worker.runWorkflows(feedbackSubject, numInFlightActivationsSubject, numRunningWorkflowInstancesSubject);
  const runId = uuid4();
  const [numInFlightActivations, numRunningWorkflowInstances] = await Promise.all([
    numInFlightActivationsSubject.pipe(take(5), toArray()).toPromise(),
    numRunningWorkflowInstancesSubject.pipe(take(3), toArray()).toPromise(),
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
  const { worker, feedbackSubject, numInFlightActivationsSubject, numRunningWorkflowInstancesSubject } = t.context;
  const p = worker.runWorkflows(feedbackSubject, numInFlightActivationsSubject, numRunningWorkflowInstancesSubject);
  const runId = uuid4();
  worker.native.completeWorkflowActivation = () => {
    return Promise.reject(new errors.WorkflowError('Something bad happened', runId, 'details'));
  };
  const promises = Promise.all([
    numInFlightActivationsSubject.pipe(take(3), toArray()).toPromise(),
    numRunningWorkflowInstancesSubject.pipe(take(3), toArray()).toPromise(),
    feedbackSubject
      .pipe(
        tap((activation) => console.log('feedback', activation)),
        first()
      )
      .toPromise(),
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
