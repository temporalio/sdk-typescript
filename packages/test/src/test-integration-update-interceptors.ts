import { WorkflowStartUpdateInput, WorkflowStartUpdateOutput } from '@temporalio/client';
import * as wf from '@temporalio/workflow';
import { Next, UpdateInput, WorkflowInboundCallsInterceptor, WorkflowInterceptors } from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';

const update = wf.defineUpdate<string[], [string]>('update');

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
    // TODO: remove this server config when default test server supports update
    server: {
      executable: {
        type: 'cached-download',
        version: 'latest',
      },
    },
  },
});

export async function workflowWithUpdates(): Promise<string[]> {
  const state: string[] = [];
  const updateHandler = async (arg: string): Promise<string[]> => {
    state.push(arg);
    if (arg === 'fail-update') {
      throw new wf.ApplicationFailure(`Deliberate ApplicationFailure in handler`);
    }
    return state;
  };
  wf.setHandler(update, updateHandler);
  await wf.condition(() => state.includes('done'));
  state.push('$');
  return state;
}

class UpdateInboundCallsInterceptor implements WorkflowInboundCallsInterceptor {
  async handleUpdate(input: UpdateInput, next: Next<UpdateInboundCallsInterceptor, 'handleUpdate'>): Promise<unknown> {
    return await next({ ...input, args: [input.args[0] + '-inboundIntercepted', ...input.args.slice(1)] });
  }
}

export const interceptors = (): WorkflowInterceptors => ({
  inbound: [new UpdateInboundCallsInterceptor()],
});

test('Update client and inbound interceptors work for executeUpdate', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdates);

    const updateResult = await wfHandle.executeUpdate(update, { args: ['1'] });
    t.deepEqual(updateResult, ['1-clientIntercepted-inboundIntercepted']);
  });
});

test('Update client and inbound interceptors work for startUpdate', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdates);

    const updateHandle = await wfHandle.startUpdate(update, { args: ['1'] });
    const updateResult = await updateHandle.result();
    t.deepEqual(updateResult, ['1-clientIntercepted-inboundIntercepted']);
  });
});
