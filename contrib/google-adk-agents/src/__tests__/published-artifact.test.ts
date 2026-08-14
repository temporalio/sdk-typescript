/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Regression test that consumes the COMPILED `lib` the way a published-package
 * user does: resolved BY PACKAGE NAME (`@temporalio/google-adk-agents` and its
 * `/workflow` and `/testing` subpaths) via Node package self-reference, never
 * via relative `../` source paths.
 */

import { createRequire } from 'node:module';

import test from 'ava';

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
