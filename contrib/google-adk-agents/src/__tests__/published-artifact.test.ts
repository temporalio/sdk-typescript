/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Regression tests that consume the COMPILED `lib` the way a published-package
 * user does: resolved BY PACKAGE NAME (`@temporalio/google-adk-agents` and its
 * `/workflow` and `/testing` subpaths), never via relative `../` source paths.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

import test from 'ava';
import { Worker } from '@temporalio/worker';

import { GoogleAdkPlugin } from '../index.js';
import { fakeModelProvider } from '../testing.js';
import { setupTestEnv, uid } from './helpers.js';

const getEnv = setupTestEnv(test);

// (a) CJS require by name: a CommonJS consumer must be able to `require` the
// main entry and the `/workflow` and `/testing` subpaths and see the
// documented exports.
test('cjsRequireExposesPublicExports', (t) => {
  const require = createRequire(__filename);

  const main = require('@temporalio/google-adk-agents');
  t.is(typeof main.GoogleAdkPlugin, 'function');

  const workflow = require('@temporalio/google-adk-agents/workflow');
  t.is(typeof workflow.TemporalModel, 'function');
  t.is(typeof workflow.TemporalMCPToolset, 'function');
  t.is(typeof workflow.activityAsTool, 'function');

  const testing = require('@temporalio/google-adk-agents/testing');
  t.is(typeof testing.fakeModelProvider, 'function');
  t.is(typeof testing.mockMCPToolset, 'function');
});

// (b) lib-bundle Workflow: the by-name import in the fixture forces webpack to
// resolve `@temporalio/google-adk-agents` to the built `lib`, proving the
// published artifact bundles into a Workflow with no webpack error and runs.
test.serial('libBundlesAndRunsInWorkflow', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-published');
  // `__dirname` is `lib/__tests__` at runtime; the fixture's TS source ships
  // alongside it under `src/__tests__`.
  const workflowsPath = path.resolve(__dirname, '../../src/__tests__/workflows-published.ts');
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath,
    plugins: [new GoogleAdkPlugin({ modelProvider: fakeModelProvider() })] as any,
  });
  const result = await worker.runUntil(
    env.client.workflow.execute('publishedSingleModelCall', {
      taskQueue,
      workflowId: uid('wf-published'),
      args: ['hello'],
    })
  );
  // FakeLlm's default response encodes the resolved model name, proving the
  // lib-resolved `TemporalModel` dispatched through the activity boundary.
  t.is(result, 'fake-response:fake-model');
});
