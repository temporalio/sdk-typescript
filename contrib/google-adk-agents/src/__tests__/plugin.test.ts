/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Server-free unit tests that assert the shape of `configureBundler` /
 * `configureWorker` output without bundling or executing a Workflow.
 */

import test from 'ava';
import type { BundleOptions, WorkerOptions } from '@temporalio/worker';

import { GoogleAdkPlugin } from '../index';
import { mockMCPToolset } from '../testing';

interface NamedPlugin {
  name?: string;
}
interface WebpackConfigLike {
  plugins?: NamedPlugin[];
}

test('configureBundler stubs ADK node-only packages and disallowed builtins', (t) => {
  const plugin = new GoogleAdkPlugin();
  const { ignoreModules } = plugin.configureBundler({ workflowsPath: 'wf' } as BundleOptions);
  const ignored = new Set(ignoreModules ?? []);

  for (const pkg of [
    'google-auth-library',
    'googleapis',
    '@modelcontextprotocol/sdk',
    '@google-cloud/storage',
    'express',
  ]) {
    t.true(ignored.has(pkg), `expected ADK node-only package ${pkg} to be stubbed`);
  }
  for (const builtin of ['fs', 'child_process', 'net']) {
    t.true(ignored.has(builtin), `expected disallowed builtin ${builtin} to be stubbed`);
  }
  // The three sandbox-polyfilled builtins must stay resolvable.
  for (const polyfilled of ['assert', 'url', 'util']) {
    t.false(ignored.has(polyfilled), `expected polyfilled builtin ${polyfilled} to remain`);
  }
});

test('configureBundler appends the sandbox-compat plugin, preserving a user hook', (t) => {
  const userHook = (config: WebpackConfigLike): WebpackConfigLike => {
    config.plugins = [...(config.plugins ?? []), { name: 'user-plugin' }];
    return config;
  };
  const plugin = new GoogleAdkPlugin();
  const { webpackConfigHook } = plugin.configureBundler({
    workflowsPath: 'wf',
    webpackConfigHook: userHook,
  } as unknown as BundleOptions);
  t.is(typeof webpackConfigHook, 'function');

  const result = webpackConfigHook!({ plugins: [] } as never) as WebpackConfigLike;
  const names = (result.plugins ?? []).map((p) => p.name);
  t.deepEqual(names, ['user-plugin', 'google-adk-sandbox-compat']);
});

test('configureWorker registers model activities, plus an MCP pair per toolset', (t) => {
  const modelOnly = new GoogleAdkPlugin().configureWorker({ taskQueue: 'tq' } as WorkerOptions).activities as Record<
    string,
    unknown
  >;
  t.is(typeof modelOnly.invokeModel, 'function');
  t.is(typeof modelOnly.invokeModelStreaming, 'function');

  const withMcp = new GoogleAdkPlugin({ mcpToolsets: { weather: mockMCPToolset([]) } });
  const activities = withMcp.configureWorker({ taskQueue: 'tq' } as WorkerOptions).activities as Record<
    string,
    unknown
  >;
  t.is(typeof activities['weather-listTools'], 'function');
  t.is(typeof activities['weather-callTool'], 'function');
});
