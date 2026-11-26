import { temporal } from '@temporalio/proto';
import * as wf from '@temporalio/workflow';
import { waitUntil } from './helpers';
import { helpers, makeTestFunction } from './helpers-integration';

const test = makeTestFunction({ workflowsPath: __filename });

export const startWork = wf.defineUpdate<void, []>('startWork');

/**
 * Waits for an Update to open a gate, then starts a Timer.
 *
 * The workflow's first Workflow Task completes without any command, and the Update later arrives in a
 * second, speculative Workflow Task. That `WFT (no commands) -> WFT (Update)` sequence is
 * indistinguishable, from history alone, from a Workflow Task heartbeat. If Core collapses the two into a
 * single logical Workflow Task on replay, the Update is replayed in the wrong position relative to the
 * Timer command, resulting in a nondeterminism error.
 */
export async function updateAfterEmptyWorkflowTask(): Promise<void> {
  let canStart = false;
  // The handler must be async: it is the extra microtask hops that make the Update's completion get emitted after
  // the Timer command, which is what makes the ordering observable on replay.
  wf.setHandler(startWork, async () => {
    await (async () => {
      canStart = true;
    })();
  });

  await wf.condition(() => canStart);
  await wf.sleep('1 seconds');
}

test('Update received after an empty Workflow Task does not cause non-determinism error on replay', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  // Force a full history replay on every Workflow Task.
  const worker = await createWorker({ maxCachedWorkflows: 0 });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(updateAfterEmptyWorkflowTask, {
      // A non-deterministic workflow would otherwise retry its Workflow Task forever.
      workflowExecutionTimeout: '30s',
    });

    // Make sure that the first Workflow Task has completed (with no commands) before sending the Update,
    // so that the Update ends up in its own Workflow Task.
    await waitUntil(async () => {
      const { events } = await handle.fetchHistory();
      return (events ?? []).some(
        (e) => e.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_TASK_COMPLETED
      );
    }, 10_000);

    await handle.executeUpdate(startWork);

    // If the workflow completes, the history was replayed deterministically.
    await handle.result();
  });

  t.pass();
});
