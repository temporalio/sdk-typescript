import * as wf from '@temporalio/workflow';
import { Next, UpdateInput, WorkflowInboundCallsInterceptor } from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';

const update = wf.defineUpdate<string[], [string]>('update');
const doneUpdate = wf.defineUpdate<void, []>('done-update');

export async function workflowWithUpdates(): Promise<string[]> {
  const state: string[] = [];
  const updateHandler = async (arg: string): Promise<string[]> => {
    state.push(arg);
    if (arg === 'fail-update') {
      throw new wf.ApplicationFailure(`Deliberate ApplicationFailure in handler`);
    }
    return state;
  };
  const doneUpdateHandler = (): void => {
    state.push('done');
  };
  const validator = (arg: string): void => {
    if (arg === 'bad-arg') {
      throw new Error('Validation failed');
    }
  };
  wf.setHandler(update, updateHandler, { validator });
  wf.setHandler(doneUpdate, doneUpdateHandler);
  await wf.condition(() => state.includes('done'));
  state.push('$');
  return state;
}

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
  // TODO: remove this server config when default test server supports update
  workflowEnvironmentOpts: {
    server: {
      executable: {
        type: 'cached-download',
        version: 'latest',
      },
    },
  },
});

class UpdateInboundCallsInterceptor implements WorkflowInboundCallsInterceptor {
  validateUpdate(input: UpdateInput, next: Next<UpdateInboundCallsInterceptor, 'validateUpdate'>): void {
    next({ ...input, args: ['bad-arg'] });
  }
}

export const interceptors = (): wf.WorkflowInterceptors => ({
  inbound: [new UpdateInboundCallsInterceptor()],
});

test('Update validation interceptor works', async (t) => {
  const { createWorker, startWorkflow, assertWorkflowUpdateFailed } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdates);

    await assertWorkflowUpdateFailed(
      wfHandle.executeUpdate(update, { args: ['1'] }),
      wf.ApplicationFailure,
      'Validation failed'
    );

    const doneUpdateResult = await wfHandle.executeUpdate(doneUpdate);
    t.is(doneUpdateResult, undefined);

    const wfResult = await wfHandle.result();
    t.deepEqual(wfResult, ['done', '$']);
  });
});
