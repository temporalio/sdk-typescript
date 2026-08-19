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
  t.false('MODEL_ERROR_FAILURE_TYPE' in main);

  const workflow = require('@temporalio/google-adk-agents/workflow');
  t.is(typeof workflow.TemporalModel, 'function');
  t.is(typeof workflow.TemporalMCPToolset, 'function');
  t.is(typeof workflow.activityAsTool, 'function');
  t.is(workflow.MODEL_ERROR_FAILURE_TYPE, 'GoogleAdkModelError');
  t.is(workflow.MCP_TOOL_NOT_FOUND_FAILURE_TYPE, 'GoogleAdkMCPToolNotFound');
  t.is(workflow.MCP_ERROR_FAILURE_TYPE, 'GoogleAdkMCPError');
  t.is(workflow.STREAMING_TOPIC_REQUIRED_FAILURE_TYPE, 'GoogleAdkStreamingTopicRequired');
  t.is(workflow.UNSUPPORTED_FAILURE_TYPE, 'GoogleAdkUnsupported');
  t.false('MCP_TOOLSET_OUTSIDE_WORKFLOW_FAILURE_TYPE' in workflow);
  t.false('ACTIVITY_TOOL_OUTSIDE_WORKFLOW_FAILURE_TYPE' in workflow);

  const testing = require('@temporalio/google-adk-agents/testing');
  t.is(typeof testing.fakeModelProvider, 'function');
  t.is(typeof testing.mockMCPToolset, 'function');
});
