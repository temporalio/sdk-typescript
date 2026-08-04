/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Coverage for the `net` builtin shim. `@google/adk` >= 1.5.0 ships
 * `tools/load_web_page.js` on the barrel path, which parses its blocked-CIDR
 * tables at module load, calling `isIP` from `node:net` in the process — with
 * `net` aliased to an empty module every Workflow task would fail at bundle
 * load. The parity test pins the shim's classifiers to `node:net`'s, and the
 * E2E test drives the same top-level pattern (mirrored in `workflows.ts`)
 * through a real Worker.
 */

import net from 'node:net';

import test from 'ava';
import type { BundleOptions } from '@temporalio/worker';

import { GoogleAdkPlugin } from '../index';
import { fakeModelProvider } from '../testing';
import { setupTestEnv, uid, withWorker } from './helpers';
import { netShimProbe } from './workflows';

const getEnv = setupTestEnv(test);

interface ResolveData {
  request?: string;
}

/**
 * Applies the sandbox-compat webpack plugin (obtained through the public
 * `configureBundler` surface) to a stub compiler and returns its
 * `beforeResolve` request mapper.
 */
function beforeResolveMapper(): (request: string) => string {
  const plugin = new GoogleAdkPlugin();
  const { webpackConfigHook } = plugin.configureBundler({ workflowsPath: 'wf' } as BundleOptions);
  const cfg = webpackConfigHook!({ plugins: [] } as never) as {
    plugins?: Array<{ name?: string; apply?: (compiler: unknown) => void }>;
  };
  const compat = (cfg.plugins ?? []).find((p) => p.name === 'google-adk-sandbox-compat');
  if (!compat?.apply) throw new Error('google-adk-sandbox-compat plugin not found in the webpack config');
  let hook: ((data: ResolveData) => void) | undefined;
  compat.apply({
    webpack: {
      ProvidePlugin: class {
        apply(): void {}
      },
    },
    hooks: {
      normalModuleFactory: {
        tap: (_name: string, fn: (nmf: unknown) => void) =>
          fn({
            hooks: {
              beforeResolve: {
                tap: (_tapName: string, f: (data: ResolveData) => void) => {
                  hook = f;
                },
              },
            },
          }),
      },
    },
  });
  if (!hook) throw new Error('the sandbox-compat plugin did not tap beforeResolve');
  return (request) => {
    const data: ResolveData = { request };
    hook!(data);
    return data.request!;
  };
}

// The shim reimplements Node's own address grammar; what a Workflow computes
// from the bundled shim must match what `node:net` reports on the worker.
test('net shim classifies addresses exactly like node:net', async (t) => {
  const mapper = beforeResolveMapper();
  const shimUri = mapper('node:net');
  t.true(shimUri.startsWith('data:text/javascript;base64,'), `expected a data: URI, got ${shimUri}`);
  t.is(mapper('net'), shimUri);

  // Compiled test files are CommonJS; `import()` must survive as a real
  // dynamic import (tsc would rewrite it to `require`, which cannot load ESM).
  const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{
    isIP(input: string): number;
    isIPv4(input: string): boolean;
    isIPv6(input: string): boolean;
  }>;
  const shim = await importModule(shimUri);

  const inputs = [
    // The IPv4/IPv6 base addresses ADK >= 1.5.0 CIDR-parses at module load.
    '0.0.0.0',
    '10.0.0.0',
    '100.64.0.0',
    '127.0.0.0',
    '169.254.0.0',
    '172.16.0.0',
    '192.0.0.0',
    '192.0.2.0',
    '192.88.99.0',
    '192.168.0.0',
    '198.18.0.0',
    '198.51.100.0',
    '203.0.113.0',
    '224.0.0.0',
    '240.0.0.0',
    '::',
    '::1',
    '64:ff9b:1::',
    '100::',
    '2001:db8::',
    'fc00::',
    'fe80::',
    'ff00::',
    // Classification corners: octet bounds, leading zeros, wrong arity,
    // embedded IPv4, full/compressed forms, zone ids, junk.
    '127.0.0.1',
    '255.255.255.255',
    '256.0.0.1',
    '127.0.0.01',
    '01.2.3.4',
    '1.2.3',
    '1.2.3.4.5',
    '1.2.3.4 ',
    '::ffff:127.0.0.1',
    '::ffff:256.1.1.1',
    '1:2:3:4:5:6:7:8',
    '1:2:3:4:5:6:7::',
    '1:2:3:4:5:6:7:8:9',
    'fe80::1%eth0',
    'fe80::1%',
    ':::',
    '1::2::3',
    'abcd::12345',
    'g::1',
    '::1 ',
    '',
    ' ',
    'localhost',
  ];
  for (const input of inputs) {
    t.is(shim.isIP(input), net.isIP(input), `isIP(${JSON.stringify(input)})`);
    t.is(shim.isIPv4(input), net.isIPv4(input), `isIPv4(${JSON.stringify(input)})`);
    t.is(shim.isIPv6(input), net.isIPv6(input), `isIPv6(${JSON.stringify(input)})`);
  }
});

// ADK 1.5.0's load-time CIDR-parse pattern loads and classifies in the sandbox (E2E)
test.serial('workflowBundleLoadsWithTopLevelNetIsIP', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-net');
  const plugin = new GoogleAdkPlugin({ modelProvider: fakeModelProvider() });
  const result = await withWorker(env, { taskQueue, plugins: [plugin] }, () =>
    env.client.workflow.execute(netShimProbe, { taskQueue, workflowId: uid('wf-net') })
  );
  t.deepEqual(result, {
    loadTime: [6, 6, 6, 6, 6, 6, 6, 6],
    runtime: [4, 6, 0],
  });
});
