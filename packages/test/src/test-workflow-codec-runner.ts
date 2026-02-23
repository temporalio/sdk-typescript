import test from 'ava';
import { coresdk } from '@temporalio/proto';
import { WorkflowCodecRunner } from '@temporalio/worker/lib/workflow-codec-runner';

test('WorkflowCodecRunner keeps signal/cancel external context maps independent', async (t) => {
  const runner = new WorkflowCodecRunner([], 'default', 'test-task-queue');

  await runner.decodeActivation({
    runId: 'test-run-id',
    jobs: [
      {
        initializeWorkflow: {
          workflowId: 'parent-workflow-id',
          workflowType: 'test-workflow',
          arguments: [],
        },
      },
    ],
  } satisfies coresdk.workflow_activation.IWorkflowActivation);

  await runner.encodeCompletion({
    runId: 'test-run-id',
    successful: {
      commands: [
        {
          signalExternalWorkflowExecution: {
            seq: 1,
            signalName: 'test-signal',
            args: [],
            headers: {},
            workflowExecution: {
              namespace: 'default',
              workflowId: 'signal-target-workflow-id',
              runId: 'signal-target-run-id',
            },
          },
        },
        {
          requestCancelExternalWorkflowExecution: {
            seq: 1,
            workflowExecution: {
              namespace: 'default',
              workflowId: 'cancel-target-workflow-id',
              runId: 'cancel-target-run-id',
            },
          },
        },
      ],
    },
  } satisfies coresdk.workflow_completion.IWorkflowActivationCompletion);

  const runState = (runner as any).runStates.get('test-run-id');
  t.truthy(runState);
  t.is(runState.signalExternalWorkflowContexts.get(1)?.workflowId, 'signal-target-workflow-id');
  t.is(runState.cancelExternalWorkflowContexts.get(1)?.workflowId, 'cancel-target-workflow-id');

  await runner.decodeActivation({
    runId: 'test-run-id',
    jobs: [
      {
        resolveSignalExternalWorkflow: {
          seq: 1,
        },
      },
      {
        resolveRequestCancelExternalWorkflow: {
          seq: 1,
        },
      },
    ],
  } satisfies coresdk.workflow_activation.IWorkflowActivation);

  t.false(runState.signalExternalWorkflowContexts.has(1));
  t.false(runState.cancelExternalWorkflowContexts.has(1));
});
