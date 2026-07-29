import { temporal } from '@temporalio/proto';
import { createTestWorkflowBundle, helpers, makeTestFunction } from './helpers-integration';
import {
  finishPatchActivationWorkflow,
  patchActivationResult,
  patchActivationRolloutWorkflow,
} from './workflows/patch-activation-callback-new';

const test = makeTestFunction({
  workflowsPath: require.resolve('./workflows/patch-activation-callback-new'),
});

test.serial('declined patch can roll back to old Workflow code', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  let callbackCalls = 0;
  const newWorker = await createWorker({
    patchActivationCallback(input) {
      callbackCalls++;
      t.is(input.workflowInfo.workflowType, 'patchActivationRolloutWorkflow');
      t.is(input.patchId, 'patch-activation-callback-rollout');
      return false;
    },
  });
  const handle = await startWorkflow(patchActivationRolloutWorkflow);
  t.false(await newWorker.runUntil(() => handle.query(patchActivationResult)));
  t.is(callbackCalls, 1);

  const oldBundle = await createTestWorkflowBundle({
    workflowsPath: require.resolve('./workflows/patch-activation-callback-old'),
  });
  const oldWorker = await createWorker({ workflowBundle: oldBundle });
  const result = await oldWorker.runUntil(async () => {
    await handle.signal(finishPatchActivationWorkflow);
    return await handle.result();
  });
  t.is(result, 'old');

  const history = await handle.fetchHistory();
  t.false(
    history.events?.some((event) => event.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_MARKER_RECORDED) ??
      false
  );
});

test.serial('recorded patch bypasses declining callback on a new Worker', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  let activatingCalls = 0;
  const activatingWorker = await createWorker({
    patchActivationCallback() {
      activatingCalls++;
      return true;
    },
  });
  const handle = await startWorkflow(patchActivationRolloutWorkflow);
  t.true(await activatingWorker.runUntil(() => handle.query(patchActivationResult)));
  t.is(activatingCalls, 1);

  let decliningCalls = 0;
  const decliningWorker = await createWorker({
    patchActivationCallback() {
      decliningCalls++;
      return false;
    },
  });
  const result = await decliningWorker.runUntil(async () => {
    await handle.signal(finishPatchActivationWorkflow);
    return await handle.result();
  });
  t.is(result, 'new');
  t.is(decliningCalls, 0);

  const history = await handle.fetchHistory();
  t.true(
    history.events?.some((event) => event.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_MARKER_RECORDED) ??
      false
  );
});
