/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Regression tests that consume the COMPILED `lib` the way a published-package
 * user does: resolved BY PACKAGE NAME (`@temporalio/google-adk-agents` and its
 * `/testing` subpath), never via relative `../` source paths. Together these
 * guard the three bugs the CommonJS-build conversion fixed:
 *
 *   Bug 1: the package's `exports` were `import`-only, so a CommonJS `require`
 *          of the package threw. The CJS test below `require`s the package by
 *          name and asserts the expected exports are present.
 *   Bugs 2 & 3: the lib failed to bundle into / run inside a Workflow. The
 *          lib-bundle test boots a Worker whose workflow fixture imports the
 *          barrel by name, so webpack resolves it to the built `lib`; a clean
 *          bundle + completed run proves both.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

import test from 'ava';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';

import { GoogleAdkPlugin } from '../index.js';
import { fakeModelProvider } from '../testing.js';

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// (a) CJS require by name: a CommonJS consumer must be able to `require` both
// the main entry and the `/testing` subpath and see the documented exports.
test('cjsRequireExposesPublicExports', (t) => {
  const require = createRequire(__filename);

  const main = require('@temporalio/google-adk-agents');
  t.is(typeof main.GoogleAdkPlugin, 'function');
  t.is(typeof main.TemporalModel, 'function');

  const testing = require('@temporalio/google-adk-agents/testing');
  t.is(typeof testing.fakeModelProvider, 'function');
  t.is(typeof testing.mockMcpToolset, 'function');
});

// (b) lib-bundle Workflow: the by-name import in the fixture forces webpack to
// resolve `@temporalio/google-adk-agents` to the built `lib`, proving the
// published artifact bundles into a Workflow with no webpack error and runs.
test.serial('libBundlesAndRunsInWorkflow', async (t) => {
  const env = await TestWorkflowEnvironment.createLocal();
  try {
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
  } finally {
    await env.teardown();
  }
});
