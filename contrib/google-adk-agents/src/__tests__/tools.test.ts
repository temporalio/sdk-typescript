/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * E2E test for `activityAsTool`: an existing Temporal Activity, registered on
 * the worker, is exposed to the ADK agent as a `BaseTool`. A tool call inside
 * the Workflow dispatches the named Activity and returns its result.
 */

import test from 'ava';
import { ApplicationFailure } from '@temporalio/common';

import { GoogleAdkPlugin } from '../index.js';
import { activityAsTool } from '../workflow.js';
import { setupTestEnv, uid, withWorker } from './helpers.js';
import { activityToolCall } from './workflows.js';

const getEnv = setupTestEnv(test);

// activityAsTool (E2E)
test.serial('wrapsActivityAsTool', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-tool');

  // A user's existing Temporal Activity.
  const activities = {
    async lookupOrder(args: { orderId: string }): Promise<unknown> {
      return { orderId: args.orderId, status: 'shipped' };
    },
  };

  const result = await withWorker(
    env,
    {
      taskQueue,
      plugins: [new GoogleAdkPlugin()],
      activities: activities as unknown as Record<string, (...a: never[]) => Promise<unknown>>,
    },
    () =>
      env.client.workflow.execute(activityToolCall, {
        taskQueue,
        workflowId: uid('wf-tool'),
        args: ['order-42'],
      })
  );

  t.deepEqual(result, { orderId: 'order-42', status: 'shipped' });
});

// activityAsTool outside a Workflow
test('activityAsToolOutsideWorkflowFails', async (t) => {
  const tool = activityAsTool({ name: 'lookupOrder', description: 'Look up an order by id.' });
  const err = await t.throwsAsync(tool.runAsync({ args: {}, toolContext: {} as never }));
  t.true(err instanceof ApplicationFailure);
  t.is((err as ApplicationFailure).type, 'GoogleAdkActivityToolOutsideWorkflow');
  t.is((err as ApplicationFailure).nonRetryable, true);
});
