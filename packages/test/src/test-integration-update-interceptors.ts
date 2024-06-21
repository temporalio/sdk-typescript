import { WorkflowStartUpdateInput, WorkflowStartUpdateOutput } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import * as wf from '@temporalio/workflow';
import { Next, UpdateInput, WorkflowInboundCallsInterceptor, WorkflowInterceptors } from '@temporalio/workflow';
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
          },
        ],
      },
    },
  },
});

const update = wf.defineUpdate<string, [string]>('update');

export async function workflowWithUpdate(): Promise<void> {
  const updateHandler = async (arg: string): Promise<string> => arg;
  const validator = (arg: string): void => {
    if (arg === 'bad-arg') {
      throw new Error('Validation failed');
    }
  };
  wf.setHandler(update, updateHandler, { validator });
  await wf.condition(() => false); // Ensure the update is handled if it is dispatched in a second WFT.
}

class UpdateInboundCallsInterceptor implements WorkflowInboundCallsInterceptor {
  async handleUpdate(input: UpdateInput, next: Next<UpdateInboundCallsInterceptor, 'handleUpdate'>): Promise<unknown> {
    return await next({ ...input, args: [input.args[0] + '-inboundIntercepted', ...input.args.slice(1)] });
  }
  validateUpdate(input: UpdateInput, next: Next<UpdateInboundCallsInterceptor, 'validateUpdate'>): void {
    const [arg] = input.args as string[];
    const args = arg.startsWith('validation-interceptor-will-make-me-invalid') ? ['bad-arg'] : [arg];
    next({ ...input, args });
  }
}

export const interceptors = (): WorkflowInterceptors => ({
  inbound: [new UpdateInboundCallsInterceptor()],
});

test('Update client and inbound interceptors work for executeUpdate', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdate);

    const updateResult = await wfHandle.executeUpdate(update, { args: ['1'] });
    t.deepEqual(updateResult, '1-clientIntercepted-inboundIntercepted');
  });
});

test('Update client and inbound interceptors work for startUpdate', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdate);

    const updateHandle = await wfHandle.startUpdate(update, {
      args: ['1'],
      waitForStage:
        temporal.api.enums.v1.UpdateWorkflowExecutionLifecycleStage.UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_ACCEPTED,
    });
    const updateResult = await updateHandle.result();
    t.deepEqual(updateResult, '1-clientIntercepted-inboundIntercepted');
  });
});

test('Update validation interceptor works', async (t) => {
  const { createWorker, startWorkflow, assertWorkflowUpdateFailed } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdate);
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
