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
import { ApplicationFailure } from '@temporalio/common';
import { Worker } from '@temporalio/worker';

import { GoogleAdkPlugin } from '../index';
import { defaultTestProvider, findInCauseChain, REUSE_V8_CONTEXT, setupTestEnv, uid, workflowsPath } from './helpers';
import { agentRunnerOneTurn, singleModelCall } from './workflows';

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
    reuseV8Context: REUSE_V8_CONTEXT,
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
    reuseV8Context: REUSE_V8_CONTEXT,
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

// An absorbed model failure fails the Workflow when the bundle holds ONE copy of the
// absorbed-failure module (E2E)
test.serial('compiledCjsBundleSurfacesAnAbsorbedModelFailure', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-cjs-fail');
  const workflowId = uid('wf-cjs-fail');
  // Both the plugin's interceptor-module entry and the Workflow's own import of
  // `TemporalModel` resolve to the compiled `lib/`, so the bundle holds a single copy of
  // the absorbed-failure module — the topology a published consumer gets, where the
  // TypeScript-source bundle the other tests build holds two.
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: compiledWorkflowsPath,
    reuseV8Context: REUSE_V8_CONTEXT,
    plugins: [new GoogleAdkPlugin({ modelProvider: defaultTestProvider() })],
  });
  await worker.runUntil(
    (async () => {
      const handle = await env.client.workflow.start(agentRunnerOneTurn, {
        taskQueue,
        workflowId,
        args: ['boom', 'explode'],
      });
      const caught = await t.throwsAsync(handle.result());
      t.is(findInCauseChain(caught, ApplicationFailure)?.type, 'GoogleAdkModelError.400');
      t.is((await handle.describe()).status.name, 'FAILED');
    })()
  );
});
