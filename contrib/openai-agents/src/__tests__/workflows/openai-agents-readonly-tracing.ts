/**
 * Minimal Workflow for the read-only-handler tracing test. It stays open on a
 * `condition()` so the driver can issue repeated Queries and update validations
 * against a live execution. The handlers do no agent work — the `temporal:*`
 * spans emitted by the trace interceptor around each read-only evaluation are
 * the unit under test.
 */
import { condition, defineQuery, defineSignal, defineUpdate, setHandler } from '@temporalio/workflow';

export const pingQuery = defineQuery<string>('ping');
export const noopUpdate = defineUpdate<string, [string]>('noopUpdate');
export const finishSignal = defineSignal('finish');

export async function readonlyTracingWorkflow(): Promise<string> {
  let done = false;

  setHandler(pingQuery, () => 'pong');
  setHandler(noopUpdate, (value: string) => `handled-${value}`, {
    validator: (value: string) => {
      if (!value) throw new Error('value required');
    },
  });
  setHandler(finishSignal, () => {
    done = true;
  });

  await condition(() => done);
  return 'done';
}
