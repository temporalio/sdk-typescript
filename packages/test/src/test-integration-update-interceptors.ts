import { randomUUID } from 'crypto';
import type {
  WorkflowStartUpdateInput,
  WorkflowStartUpdateOutput,
  WorkflowStartUpdateWithStartInput,
  WorkflowStartUpdateWithStartOutput,
} from '@temporalio/client';
import { WithStartWorkflowOperation, WorkflowUpdateStage } from '@temporalio/client';
import * as wf from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';
import {
  update,
  workflowWithUpdate,
  workflowWithUpdateWithoutValidator,
} from './workflows/integration-update-interceptors';

const test = makeTestFunction({
  workflowInterceptorModules: [require.resolve('./workflows/integration-update-interceptors')],
  workflowEnvironmentOpts: {
    client: {
      interceptors: {
        workflow: [
          {
            async startUpdate(input: WorkflowStartUpdateInput, next): Promise<WorkflowStartUpdateOutput> {
              return next({ ...input, args: [input.args[0] + '-clientIntercepted', ...input.args.slice(1)] });
            },
            async startUpdateWithStart(
              input: WorkflowStartUpdateWithStartInput,
              next
            ): Promise<WorkflowStartUpdateWithStartOutput> {
              return next({
                ...input,
                workflowStartOptions: {
                  ...input.workflowStartOptions,
                  args: [
                    input.workflowStartOptions.args[0] + '-clientIntercepted',
                    ...input.workflowStartOptions.args.slice(1),
                  ],
                },
                updateArgs: [input.updateArgs[0] + '-clientIntercepted', ...input.updateArgs.slice(1)],
              });
            },
          },
        ],
      },
    },
  },
});

test('Update client and workflow interceptors work for executeUpdate', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdate, { args: ['wfArg'] });

    const updateResult = await wfHandle.executeUpdate(update, { args: ['1'] });
    t.deepEqual(updateResult, '1-clientIntercepted-workflowIntercepted');
  });
});

test('Update client and workflow interceptors work for startUpdate', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdate, { args: ['wfArg'] });

    const updateHandle = await wfHandle.startUpdate(update, {
      args: ['1'],
      waitForStage: WorkflowUpdateStage.ACCEPTED,
    });
    const updateResult = await updateHandle.result();
    t.deepEqual(updateResult, '1-clientIntercepted-workflowIntercepted');
  });
});

test('UpdateWithStart client and workflow interceptors work for executeUpdateWithStart', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const startWorkflowOperation = new WithStartWorkflowOperation(workflowWithUpdate, {
      workflowId: randomUUID(),
      taskQueue,
      workflowIdConflictPolicy: 'FAIL',
      args: ['wfArg'],
    });
    const updateResult = await t.context.env.client.workflow.executeUpdateWithStart(update, {
      args: ['updArg'],
      startWorkflowOperation,
    });
    t.deepEqual(updateResult, 'updArg-clientIntercepted-workflowIntercepted');
    const wfHandle = await startWorkflowOperation.workflowHandle();
    const wfResult = await wfHandle.result();
    t.deepEqual(wfResult, 'wfArg-clientIntercepted');
  });
});

test('Update validation interceptor works', async (t) => {
  const { createWorker, startWorkflow, assertWorkflowUpdateFailed } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdate, { args: ['wfArg'] });
    await assertWorkflowUpdateFailed(
      wfHandle.executeUpdate(update, { args: ['validation-interceptor-will-make-me-invalid'] }),
      wf.ApplicationFailure,
      'Validation failed'
    );
    t.pass();
  });
});

test('Update validation interceptors are not run when no validator', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdateWithoutValidator);
    const arg = 'validation-interceptor-will-make-me-invalid';
    const result = await wfHandle.executeUpdate(update, { args: [arg] });
    t.true(result.startsWith(arg));
  });
});
