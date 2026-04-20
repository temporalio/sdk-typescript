import { randomUUID } from 'crypto';
import type {
  WorkflowStartUpdateInput,
  WorkflowStartUpdateOutput,
  WorkflowStartUpdateWithStartInput,
  WorkflowStartUpdateWithStartOutput,
} from '@temporalio/client';
import { WithStartWorkflowOperation, WorkflowUpdateStage } from '@temporalio/client';
import * as wf from '@temporalio/workflow';
import type { Next, UpdateInput, WorkflowInboundCallsInterceptor, WorkflowInterceptors } from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
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

const update = wf.defineUpdate<string, [string]>('update');

export async function workflowWithUpdate(wfArg: string): Promise<string> {
  let receivedUpdate = false;
  const updateHandler = async (arg: string): Promise<string> => {
    receivedUpdate = true;
    return arg;
  };
  const validator = (arg: string): void => {
    if (arg === 'bad-arg') {
      throw new Error('Validation failed');
    }
  };
  wf.setHandler(update, updateHandler, { validator });
  await wf.condition(() => receivedUpdate);
  return wfArg;
}

class MyWorkflowInboundCallsInterceptor implements WorkflowInboundCallsInterceptor {
  async handleUpdate(
    input: UpdateInput,
    next: Next<MyWorkflowInboundCallsInterceptor, 'handleUpdate'>
  ): Promise<unknown> {
    return await next({ ...input, args: [input.args[0] + '-workflowIntercepted', ...input.args.slice(1)] });
  }
  validateUpdate(input: UpdateInput, next: Next<MyWorkflowInboundCallsInterceptor, 'validateUpdate'>): void {
    const [arg] = input.args as string[];
    const args = arg.startsWith('validation-interceptor-will-make-me-invalid') ? ['bad-arg'] : [arg];
    next({ ...input, args });
  }
}

export const interceptors = (): WorkflowInterceptors => ({
  inbound: [new MyWorkflowInboundCallsInterceptor()],
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

export async function workflowWithUpdateWithoutValidator(): Promise<void> {
  const updateHandler = async (arg: string): Promise<string> => arg;
  wf.setHandler(update, updateHandler);
  await wf.condition(() => false); // Ensure the update is handled if it is dispatched in a second WFT.
}

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
