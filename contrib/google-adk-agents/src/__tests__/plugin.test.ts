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
  // The pure-JS OpenTelemetry tracing packages must stay resolvable:
  // `@temporalio/interceptors-opentelemetry` constructs a `BasicTracerProvider`
  // from them inside the sandbox — the SDK's only replay-safe workflow span
  // path. Re-stubbing any of these breaks composing with `OpenTelemetryPlugin`.
  for (const otel of ['@opentelemetry/api', '@opentelemetry/sdk-trace-base', '@opentelemetry/resources']) {
    t.false(ignored.has(otel), `expected OpenTelemetry package ${otel} to remain resolvable`);
  }
});

test('configureBundler prepends the polyfill loader to workflowInterceptorModules', (t) => {
  const plugin = new GoogleAdkPlugin();
  const { workflowInterceptorModules } = plugin.configureBundler({
    workflowsPath: 'wf',
    workflowInterceptorModules: ['user-interceptors'],
  } as BundleOptions);
  // Must be first so the web-global polyfills install before any other
  // per-workflow module (interceptors, then the user's workflows) evaluates.
  t.is(workflowInterceptorModules?.[0], require.resolve('../load-polyfills'));
  t.deepEqual(workflowInterceptorModules?.slice(1), ['user-interceptors']);
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
  t.is(typeof modelOnly['adk-invokeModel'], 'function');
  t.is(typeof modelOnly['adk-invokeModelStreaming'], 'function');

  const withMcp = new GoogleAdkPlugin({ mcpToolsets: { weather: mockMCPToolset([]) } });
  const activities = withMcp.configureWorker({ taskQueue: 'tq' } as WorkerOptions).activities as Record<
    string,
    unknown
  >;
  t.is(typeof activities['weather-listTools'], 'function');
  t.is(typeof activities['weather-callTool'], 'function');
});
