/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Regression coverage for workflow-bundle module layouts that evaluate ADK's
 * telemetry chain (`@opentelemetry/sdk-trace-base` → `@opentelemetry/core`,
 * whose browser build dereferences the `performance` global at module load)
 * eagerly. The ESM test workflows dodge that chain through harmony-import
 * pruning; the tsc-compiled CommonJS shape — what a compiled-TS production
 * worker and the published `lib/` artifacts actually run — `require`s it
 * unconditionally, so these tests pin that such bundles load and run with
 * `GoogleAdkPlugin` alone (no `OpenTelemetryPlugin` composed).
 */

import path from 'node:path';

import test from 'ava';
import { Worker } from '@temporalio/worker';

import { GoogleAdkPlugin } from '../index';
import { defaultTestProvider, setupTestEnv, uid, workflowsPath } from './helpers';
import { singleModelCall } from './workflows';

const getEnv = setupTestEnv(test);

// `__dirname` is `lib/__tests__` at runtime, so these resolve to the
// tsc-compiled CommonJS artifacts, not the TypeScript sources.
const compiledWorkflowsPath = path.resolve(__dirname, './workflows.js');
const compiledConverterPath = path.resolve(__dirname, './adk-converter.js');

// Compiled-CJS workflow files load and run without OpenTelemetryPlugin (E2E)
test.serial('compiledCjsWorkflowBundleRuns', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-cjs');
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: compiledWorkflowsPath,
    plugins: [new GoogleAdkPlugin({ modelProvider: defaultTestProvider() })],
  });
  const result = await worker.runUntil(
    env.client.workflow.execute(singleModelCall, {
      taskQueue,
      workflowId: uid('wf-cjs'),
      args: ['hello'],
    })
  );
  t.is(result, 'fake-response:fake-model');
});

// A converter module importing @google/adk works via the documented workaround (E2E)
test.serial('converterModuleImportingAdkRunsWithWorkaround', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-conv');
  // Converter modules evaluate before interceptor modules — before the
  // plugin's polyfill loader — so `adk-converter.ts` imports the workflow
  // barrel first, per the documented workaround. Its compiled-CJS form
  // evaluates the whole ADK barrel (telemetry chain included) eagerly.
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath,
    dataConverter: { payloadConverterPath: compiledConverterPath },
    plugins: [new GoogleAdkPlugin({ modelProvider: defaultTestProvider() })],
  });
  const result = await worker.runUntil(
    env.client.workflow.execute(singleModelCall, {
      taskQueue,
      workflowId: uid('wf-conv'),
      args: ['hello'],
    })
  );
  t.is(result, 'fake-response:fake-model');
});
