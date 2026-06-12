/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * E2E test for `activityAsTool`: an existing Temporal Activity, registered on
 * the worker, is exposed to the ADK agent as a `BaseTool`. A tool call inside
 * the Workflow dispatches the named Activity and returns its result.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';

import { GoogleAdkPlugin } from '../src/index.js';
import { withWorker } from './helpers.js';
import { activityToolCall } from './workflows.js';

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
});

afterAll(async () => {
  await env?.teardown();
});

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

describe('activityAsTool (E2E)', () => {
  it('wrapsActivityAsTool', async () => {
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
        activities: activities as unknown as Record<
          string,
          (...a: never[]) => Promise<unknown>
        >,
      },
      () =>
        env.client.workflow.execute(activityToolCall, {
          taskQueue,
          workflowId: uid('wf-tool'),
          args: ['order-42'],
        }),
    );

    expect(result).toEqual({ orderId: 'order-42', status: 'shipped' });
  });
});
