/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * E2E test for `activityAsTool`: an existing Temporal Activity, registered on
 * the worker, is exposed to the ADK agent as a `BaseTool`. The agent's model
 * asks for it by name, ADK dispatches the call as an Activity, and the result
 * feeds back into the next model turn.
 */

import test from 'ava';
import { ApplicationFailure } from '@temporalio/common';

import { GoogleAdkPlugin } from '../index';
import { activityAsTool } from '../workflow';
import { countScheduledActivities, setupTestEnv, ToolCallingLlm, uid, withWorker } from './helpers';
import { agentToolLoopWorkflow } from './workflows';

const getEnv = setupTestEnv(test);

// activityAsTool driven by the ADK model loop (E2E)
test.serial('dispatchesModelToolCallToActivity', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-tool');
  const workflowId = uid('wf-tool');

  // A user's existing Temporal Activity.
  const activities = {
    async lookupOrder(args: { orderId: string }): Promise<unknown> {
      return { orderId: args.orderId, status: 'shipped' };
    },
  };

  const plugin = new GoogleAdkPlugin({
    modelProvider: (model) => new ToolCallingLlm({ model, toolName: 'lookupOrder', toolArgs: { orderId: 'order-42' } }),
  });

  const result = await withWorker(env, { taskQueue, plugins: [plugin], activities }, () =>
    env.client.workflow.execute(agentToolLoopWorkflow, {
      taskQueue,
      workflowId,
      args: ['where is order-42?'],
    })
  );

  // The second turn reports what reached it: the Activity's return value as the
  // tool result, and the schema `activityAsTool` advertised — which survives
  // `toWireRequest` stripping the live `toolsDict` only because it travels in
  // `config.tools[].functionDeclarations`.
  t.is(
    result,
    'tool=lookupOrder; response={"orderId":"order-42","status":"shipped"}; declarations=lookupOrder(orderId)'
  );

  const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
  // Two model turns around exactly one tool dispatch: the loop neither stopped
  // at the tool call nor ran the tool twice.
  t.is(countScheduledActivities(events ?? [], 'adk-invokeModel'), 2);
  t.is(countScheduledActivities(events ?? [], 'lookupOrder'), 1);
});

// activityAsTool outside a Workflow
test('activityAsToolOutsideWorkflowFails', async (t) => {
  const tool = activityAsTool({ name: 'lookupOrder', description: 'Look up an order by id.' });
  const err = await t.throwsAsync(tool.runAsync({ args: {}, toolContext: {} as never }));
  t.true(err instanceof ApplicationFailure);
  t.is((err as ApplicationFailure).type, 'GoogleAdkActivityToolOutsideWorkflow');
  t.is((err as ApplicationFailure).nonRetryable, true);
});
