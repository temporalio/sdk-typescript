import * as wf from '@temporalio/workflow';
import type { Next, UpdateInput, WorkflowInboundCallsInterceptor, WorkflowInterceptors } from '@temporalio/workflow';

export const update = wf.defineUpdate<string, [string]>('update');
export async function workflowWithUpdate(wfArg: string): Promise<string> {
  let receivedUpdate = false;
  wf.setHandler(
    update,
    async (arg: string) => {
      receivedUpdate = true;
      return arg;
    },
    {
      validator: (arg) => {
        if (arg === 'bad-arg') throw new Error('Validation failed');
      },
    }
  );
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
    next({ ...input, args: arg.startsWith('validation-interceptor-will-make-me-invalid') ? ['bad-arg'] : [arg] });
  }
}
export const interceptors = (): WorkflowInterceptors => ({ inbound: [new MyWorkflowInboundCallsInterceptor()] });
export async function workflowWithUpdateWithoutValidator(): Promise<void> {
  wf.setHandler(update, async (arg: string) => arg);
  await wf.condition(() => false);
}
