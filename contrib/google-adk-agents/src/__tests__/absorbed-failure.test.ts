/**
 * Terminal-outcome tests for model failures that `@google/adk` absorbs. Because the
 * absorbed failure lets the run finish normally, every case here asserts the
 * *execution's* status, not just what the Workflow returned: a failed model call must
 * FAIL the execution, a cancel must end it CANCELLED, and a failure the caller
 * handled must leave it COMPLETED.
 */

import test from 'ava';

import { ApplicationFailure, TimeoutFailure } from '@temporalio/common';

import { GoogleAdkPlugin } from '../index';
import {
  countScheduledActivities,
  defaultTestProvider,
  findInCauseChain,
  setupTestEnv,
  uid,
  waitForScheduledActivities,
  withWorker,
} from './helpers';
import {
  adkAwaitSignal,
  adkChatUpdate,
  adkContinueUpdate,
  adkDoneSignal,
  adkRecoverSignal,
  adkStartSignal,
  agentRunnerAwaitedSignalTurn,
  agentRunnerContinueAsNew,
  agentRunnerContinueAsNewFromUpdate,
  agentRunnerFailThenSlowModel,
  agentRunnerFailureAfterTimeoutScope,
  agentRunnerFailureThenRecoveringSignal,
  agentRunnerFailureWithCompensation,
  agentRunnerOneTurn,
  agentRunnerRecoversFromCancelledModel,
  agentRunnerRecoversFromModelError,
  agentRunnerRecoversOnlyTheSecondFailure,
  agentRunnerThrowingSummary,
  agentRunnerTurnUnderTimeoutScope,
  agentRunnerUnawaitedSignalTurn,
  agentRunnerUpdateDriven,
  caughtModelCallError,
} from './workflows';

const getEnv = setupTestEnv(test);

function adkPlugin(): GoogleAdkPlugin {
  return new GoogleAdkPlugin({ modelProvider: defaultTestProvider() });
}

test.serial('modelFailureThroughTheRunnerFailsTheWorkflow', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-agent-fail');
  const workflowId = uid('wf-agent-fail');
  await withWorker(env, { taskQueue, plugins: [adkPlugin()] }, async () => {
    const handle = await env.client.workflow.start(agentRunnerOneTurn, {
      taskQueue,
      workflowId,
      args: ['boom', 'explode'],
    });
    const caught = await t.throwsAsync(handle.result());
    const appFailure = findInCauseChain(caught, ApplicationFailure);
    t.is(appFailure?.type, 'GoogleAdkModelError.400');
    t.is((await handle.describe()).status.name, 'FAILED');
  });
});

test.serial('cancellingARunnerDrivenAgentEndsCancelled', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-agent-cancel');
  const workflowId = uid('wf-agent-cancel');
  await withWorker(env, { taskQueue, plugins: [adkPlugin()] }, async () => {
    const handle = await env.client.workflow.start(agentRunnerOneTurn, {
      taskQueue,
      workflowId,
      args: ['slow-model', 'wait'],
    });
    // Cancel only once the model Activity is scheduled, so it rejects with an
    // `ActivityFailure` carrying a `CancelledFailure` cause.
    await waitForScheduledActivities(env, workflowId, 'adk-invokeModel');
    await handle.cancel();
    await t.throwsAsync(handle.result());
    t.is((await handle.describe()).status.name, 'CANCELLED');
  });
});

test.serial('cancellingAfterAnAbsorbedFailureStillEndsCancelled', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-agent-fail-cancel');
  const workflowId = uid('wf-agent-fail-cancel');
  await withWorker(env, { taskQueue, plugins: [adkPlugin()] }, async () => {
    const handle = await env.client.workflow.start(agentRunnerFailThenSlowModel, {
      taskQueue,
      workflowId,
      args: ['go'],
    });
    // Two scheduled model Activities means the failing turn is behind us, so the
    // cancellation arrives with a failure already absorbed.
    await waitForScheduledActivities(env, workflowId, 'adk-invokeModel', 2);
    await handle.cancel();
    await t.throwsAsync(handle.result());
    t.is((await handle.describe()).status.name, 'CANCELLED');
  });
});

test.serial('onModelErrorRecoveryLeavesTheWorkflowCompleted', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-agent-recover');
  const workflowId = uid('wf-agent-recover');
  await withWorker(env, { taskQueue, plugins: [adkPlugin()] }, async () => {
    const result = await env.client.workflow.execute(agentRunnerRecoversFromModelError, {
      taskQueue,
      workflowId,
      args: ['explode'],
    });
    t.is(result, 'recovered');
    t.is((await env.client.workflow.getHandle(workflowId).describe()).status.name, 'COMPLETED');
  });
});

test.serial('onModelErrorRecoveryLeavesAnEarlierFailureStanding', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-agent-recover-second');
  const workflowId = uid('wf-agent-recover-second');
  await withWorker(env, { taskQueue, plugins: [adkPlugin()] }, async () => {
    const handle = await env.client.workflow.start(agentRunnerRecoversOnlyTheSecondFailure, {
      taskQueue,
      workflowId,
      args: ['explode'],
    });
    const caught = await t.throwsAsync(handle.result());
    t.is(findInCauseChain(caught, ApplicationFailure)?.type, 'GoogleAdkModelError.400');
    t.is((await handle.describe()).status.name, 'FAILED');
  });
});

test.serial('cancellingARunnerWhoseCallbackRecoversStillEndsCancelled', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-agent-cancel-recover');
  const workflowId = uid('wf-agent-cancel-recover');
  await withWorker(env, { taskQueue, plugins: [adkPlugin()] }, async () => {
    const handle = await env.client.workflow.start(agentRunnerRecoversFromCancelledModel, {
      taskQueue,
      workflowId,
      args: ['wait'],
    });
    // The cancel reaches `onModelErrorCallback` as any other model failure does, and that
    // callback recovers from it — but a cancelled execution is not the caller's to absorb.
    await waitForScheduledActivities(env, workflowId, 'adk-invokeModel');
    await handle.cancel();
    await t.throwsAsync(handle.result());
    t.is((await handle.describe()).status.name, 'CANCELLED');
  });
});

test.serial('throwingSummaryCallbackFailsTheWorkflow', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-agent-summary');
  const workflowId = uid('wf-agent-summary');
  await withWorker(env, { taskQueue, plugins: [adkPlugin()] }, async () => {
    const handle = await env.client.workflow.start(agentRunnerThrowingSummary, {
      taskQueue,
      workflowId,
      args: ['hi'],
    });
    const caught = await t.throwsAsync(handle.result());
    t.is(findInCauseChain(caught, ApplicationFailure)?.type, 'TestSummaryFailure');
    t.is((await handle.describe()).status.name, 'FAILED');
  });
});

test.serial('handledDirectModelFailureLeavesTheWorkflowCompleted', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-direct-caught');
  const workflowId = uid('wf-direct-caught');
  await withWorker(env, { taskQueue, plugins: [adkPlugin()] }, async () => {
    const result = await env.client.workflow.execute(caughtModelCallError, { taskQueue, workflowId });
    t.is(result, 'GoogleAdkModelError.400');
    t.is((await env.client.workflow.getHandle(workflowId).describe()).status.name, 'COMPLETED');
  });
});

test.serial('aTimeoutScopeAroundAnAgentTurnLeavesTheWorkflowCompleted', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-agent-timeout-uncaught');
  const workflowId = uid('wf-agent-timeout-uncaught');
  await withWorker(env, { taskQueue, plugins: [adkPlugin()] }, async () => {
    const result = await env.client.workflow.execute(agentRunnerTurnUnderTimeoutScope, {
      taskQueue,
      workflowId,
      args: ['wait'],
    });
    t.is(result, 'timed out');
    t.is((await env.client.workflow.getHandle(workflowId).describe()).status.name, 'COMPLETED');
  });
});

test.serial('modelFailureAfterATimeoutScopedTurnFailsTheWorkflow', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-agent-fail-after-scope');
  const workflowId = uid('wf-agent-fail-after-scope');
  await withWorker(env, { taskQueue, plugins: [adkPlugin()] }, async () => {
    const handle = await env.client.workflow.start(agentRunnerFailureAfterTimeoutScope, {
      taskQueue,
      workflowId,
      args: ['wait'],
    });
    const caught = await t.throwsAsync(handle.result());
    t.is(findInCauseChain(caught, ApplicationFailure)?.type, 'GoogleAdkModelError.400');
    t.is((await handle.describe()).status.name, 'FAILED');
  });
});

test.serial('modelFailureInAnUpdateRejectsThatUpdateOnly', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-agent-update');
  const workflowId = uid('wf-agent-update');
  await withWorker(env, { taskQueue, plugins: [adkPlugin()] }, async () => {
    const handle = await env.client.workflow.start(agentRunnerUpdateDriven, { taskQueue, workflowId });

    const caught = await t.throwsAsync(handle.executeUpdate(adkChatUpdate, { args: ['boom'] }));
    t.is(findInCauseChain(caught, ApplicationFailure)?.type, 'GoogleAdkModelError.400');

    // The rejected Update's frame consumed its own failure: it leaked into neither the
    // next Update's frame nor the main function's frame.
    t.is(await handle.executeUpdate(adkChatUpdate, { args: ['fake-model'] }), 'fake-response:fake-model');
    await handle.signal(adkDoneSignal);
    await handle.result();
    t.is((await handle.describe()).status.name, 'COMPLETED');
  });
});

test.serial('modelFailureBeforeContinueAsNewFailsTheWorkflow', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-agent-can');
  const workflowId = uid('wf-agent-can');
  await withWorker(env, { taskQueue, plugins: [adkPlugin()] }, async () => {
    // The next run would use a model that answers, so a Workflow that continues as new
    // here would otherwise reach a green terminal state despite the failed turn.
    const handle = await env.client.workflow.start(agentRunnerContinueAsNew, {
      taskQueue,
      workflowId,
      args: ['boom', 'fake-model'],
    });
    const caught = await t.throwsAsync(handle.result());
    t.is(findInCauseChain(caught, ApplicationFailure)?.type, 'GoogleAdkModelError.400');
    t.is((await handle.describe()).status.name, 'FAILED');
  });
});

test.serial('modelFailureRecoveredInASignalLeavesTheMainFunctionsStanding', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-agent-signal-recover');
  const workflowId = uid('wf-agent-signal-recover');
  await withWorker(env, { taskQueue, plugins: [adkPlugin()] }, async () => {
    const handle = await env.client.workflow.start(agentRunnerFailureThenRecoveringSignal, {
      taskQueue,
      workflowId,
    });
    // Two scheduled model Activities means the main function's failing turn is behind us,
    // so the Signal's own turn is what the recovery in it applies to.
    await waitForScheduledActivities(env, workflowId, 'adk-invokeModel', 2);
    await handle.signal(adkRecoverSignal);
    const caught = await t.throwsAsync(handle.result());
    // A timeout is the main function's own failure; the turn its Signal recovered was a 400.
    t.truthy(findInCauseChain(caught, TimeoutFailure));
    t.is((await handle.describe()).status.name, 'FAILED');
  });
});

test.serial('modelFailureInAnAwaitedSignalTurnFailsTheWorkflow', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-agent-signal-awaited');
  const workflowId = uid('wf-agent-signal-awaited');
  await withWorker(env, { taskQueue, plugins: [adkPlugin()] }, async () => {
    const handle = await env.client.workflow.start(agentRunnerAwaitedSignalTurn, { taskQueue, workflowId });
    await handle.signal(adkAwaitSignal);
    const caught = await t.throwsAsync(handle.result());
    t.is(findInCauseChain(caught, ApplicationFailure)?.type, 'GoogleAdkModelError.400');
    t.is((await handle.describe()).status.name, 'FAILED');
  });
});

test.serial('modelFailureFromAnUnawaitedSignalTurnFailsTheWorkflow', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-agent-signal-unawaited');
  const workflowId = uid('wf-agent-signal-unawaited');
  await withWorker(env, { taskQueue, plugins: [adkPlugin()] }, async () => {
    const handle = await env.client.workflow.start(agentRunnerUnawaitedSignalTurn, { taskQueue, workflowId });
    await handle.signal(adkStartSignal);
    const caught = await t.throwsAsync(handle.result());
    t.is(findInCauseChain(caught, ApplicationFailure)?.type, 'GoogleAdkModelError.400');
    t.is((await handle.describe()).status.name, 'FAILED');
  });
});

test.serial('anUnrelatedSignalLeavesTheMainFunctionToCompensate', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-agent-signal-compensate');
  const workflowId = uid('wf-agent-signal-compensate');
  const activities = { compensate: async () => undefined };
  await withWorker(env, { taskQueue, plugins: [adkPlugin()], activities }, async () => {
    const handle = await env.client.workflow.start(agentRunnerFailureWithCompensation, { taskQueue, workflowId });
    await waitForScheduledActivities(env, workflowId, 'adk-invokeModel', 2);
    await handle.signal(adkDoneSignal);
    const caught = await t.throwsAsync(handle.result());
    t.is(findInCauseChain(caught, ApplicationFailure)?.type, 'GoogleAdkModelError.400');
    t.is((await handle.describe()).status.name, 'FAILED');
    // The Signal absorbed nothing, so the failure stayed in the main function's frame and
    // that function reached its `finally` before the execution failed.
    const { events } = await handle.fetchHistory();
    t.is(countScheduledActivities(events ?? [], 'compensate'), 1);
  });
});

test.serial('continueAsNewFromAnUpdateFailsOnTheMainFunctionsFailure', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-agent-can-update');
  const workflowId = uid('wf-agent-can-update');
  await withWorker(env, { taskQueue, plugins: [adkPlugin()] }, async () => {
    const handle = await env.client.workflow.start(agentRunnerContinueAsNewFromUpdate, {
      taskQueue,
      workflowId,
      args: ['boom'],
    });
    await waitForScheduledActivities(env, workflowId, 'adk-invokeModel', 2);
    const rejected = await t.throwsAsync(handle.executeUpdate(adkContinueUpdate));
    t.is(findInCauseChain(rejected, ApplicationFailure)?.type, 'GoogleAdkModelError.400');

    await handle.signal(adkDoneSignal);
    const caught = await t.throwsAsync(handle.result());
    t.is(findInCauseChain(caught, ApplicationFailure)?.type, 'GoogleAdkModelError.400');
    t.is((await handle.describe()).status.name, 'FAILED');
  });
});
