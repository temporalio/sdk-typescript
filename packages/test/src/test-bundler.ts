/**
 * Test the various states of a Worker.
 * Most tests use a mocked core, some tests run serially because they emit signals to the process
 */
import { unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join as pathJoin } from 'node:path';
import { randomUUID } from 'crypto';
import type { ExecutionContext } from 'ava';
import test from 'ava';
import { moduleMatches } from '@temporalio/worker/lib/workflow/bundler';
import type { LogEntry, WorkerOptions } from '@temporalio/worker';
import { bundleWorkflowCode, DefaultLogger } from '@temporalio/worker';
import { Client } from '@temporalio/client';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { issue516 } from './mocks/workflows-with-node-dependencies/issue-516';
import { preloadSharedCounter } from './workflows/preload-shared-counter';
import { workflowWithPrebundledDep } from './workflows/workflow-with-prebundled-dep';
import { successString } from './workflows';

test('moduleMatches works', (t) => {
  t.true(moduleMatches('fs', ['fs']));
  t.true(moduleMatches('fs/lib/foo', ['fs']));
  t.false(moduleMatches('fs', ['foo']));
});

async function runPreloadSharedCounter(
  t: ExecutionContext,
  workerOptions: Pick<WorkerOptions, 'bundlerOptions' | 'workflowBundle' | 'workflowsPath'>
): Promise<[number, number]> {
  const taskQueue = `${t.title}-${randomUUID()}`;
  const client = new Client();
  const worker = await Worker.create({
    taskQueue,
    reuseV8Context: true,
    ...workerOptions,
  });
  return await worker.runUntil(async () => {
    const first = await client.workflow.execute(preloadSharedCounter, { taskQueue, workflowId: randomUUID() });
    const second = await client.workflow.execute(preloadSharedCounter, { taskQueue, workflowId: randomUUID() });
    return [first, second];
  });
}

if (RUN_INTEGRATION_TESTS) {
  test('Worker can be created from bundle code', async (t) => {
    const taskQueue = `${t.title}-${randomUUID()}`;
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows'),
    });
    const worker = await Worker.create({
      taskQueue,
      workflowBundle,
    });
    const client = new Client();
    await worker.runUntil(client.workflow.execute(successString, { taskQueue, workflowId: randomUUID() }));
    t.pass();
  });

  test('Worker can be created from bundle path', async (t) => {
    const taskQueue = `${t.title}-${randomUUID()}`;
    const { code } = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows'),
    });
    const uid = randomUUID();
    const codePath = pathJoin(os.tmpdir(), `workflow-bundle-${uid}.js`);
    await writeFile(codePath, code);
    const workflowBundle = { codePath };
    const worker = await Worker.create({
      taskQueue,
      workflowBundle,
    });
    const client = new Client();
    try {
      await worker.runUntil(client.workflow.execute(successString, { taskQueue, workflowId: randomUUID() }));
    } finally {
      await unlink(codePath);
    }
    t.pass();
  });

  test('Workflow bundle can be created from code using ignoreModules', async (t) => {
    const taskQueue = `${t.title}-${randomUUID()}`;
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./mocks/workflows-with-node-dependencies/issue-516'),
      ignoreModules: ['dns'],
    });
    const worker = await Worker.create({
      taskQueue,
      workflowBundle,
    });
    const client = new Client();
    await worker.runUntil(client.workflow.execute(issue516, { taskQueue, workflowId: randomUUID() }));
    t.pass();
  });

  test('An error is thrown when workflow depends on a node built-in module', async (t) => {
    const logs: LogEntry[] = [];
    const logger = new DefaultLogger('WARN', (entry: LogEntry) => {
      logs.push(entry);
      console.warn(entry.message);
    });

    await t.throwsAsync(
      bundleWorkflowCode({
        workflowsPath: require.resolve('./mocks/workflows-with-node-dependencies/issue-516'),
        logger,
      }),
      {
        instanceOf: Error,
        message: /is importing the following disallowed modules.*dns/s,
      }
    );
  });

  test('WorkerOptions.bundlerOptions.webpackConfigHook works', async (t) => {
    const taskQueue = `${t.title}-${randomUUID()}`;
    await t.throwsAsync(
      Worker.create({
        taskQueue,
        workflowsPath: require.resolve('./workflows'),
        bundlerOptions: {
          webpackConfigHook: (config) => {
            t.is(config.mode, 'development');
            config.mode = 'invalid' as any;
            return config;
          },
        },
      }),
      {
        name: 'ValidationError',
        message: /Invalid configuration object./,
      }
    );
  });

  test('Workflow bundle handles protobufjs optional fs shim without ignoring fs', async (t) => {
    await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/protobufs'),
      payloadConverterPath: require.resolve('./payload-converters/proto-payload-converter'),
    });

    t.pass();
  });

  test('Workflow bundle can preload modules into the reusable V8 context', async (t) => {
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/preload-shared-counter'),
      preloadModules: [require.resolve('./workflows/preload-shared-counter-helper')],
    });

    t.deepEqual(await runPreloadSharedCounter(t, { workflowBundle }), [1, 2]);
  });

  test('Workflow bundle keeps module state isolated without preloadModules', async (t) => {
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/preload-shared-counter'),
    });

    t.deepEqual(await runPreloadSharedCounter(t, { workflowBundle }), [1, 1]);
  });

  test('Workflow bundle treats an empty preloadModules list as a no-op', async (t) => {
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/preload-shared-counter'),
      preloadModules: [],
    });

    t.deepEqual(await runPreloadSharedCounter(t, { workflowBundle }), [1, 1]);
  });

  test('WorkerOptions.bundlerOptions.preloadModules works', async (t) => {
    t.deepEqual(
      await runPreloadSharedCounter(t, {
        workflowsPath: require.resolve('./workflows/preload-shared-counter'),
        bundlerOptions: {
          preloadModules: [require.resolve('./workflows/preload-shared-counter-helper')],
        },
      }),
      [1, 2]
    );
  });

  test('An error is thrown when a preloaded module is also ignored', async (t) => {
    const helperModule = require.resolve('./workflows/preload-shared-counter-helper');

    await t.throwsAsync(
      bundleWorkflowCode({
        workflowsPath: require.resolve('./workflows/preload-shared-counter'),
        ignoreModules: [helperModule],
        preloadModules: [helperModule],
      }),
      {
        instanceOf: Error,
        message: /Cannot preload modules that are also ignored: .*preload-shared-counter-helper/,
      }
    );
  });

  // Regression test: workflow bundles must not include @temporalio/proto sources.
  test('Workflow bundle does not include @temporalio/proto sources and fits within size limit', async (t) => {
    const bundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/workflow-with-standard-api-usage'),
    });

    // The bundle has an inline source map appended as a single-line comment; separate them.
    const SOURCEMAP_LINE_PREFIX = '//# sourceMappingURL=data:application/json;charset=utf-8;base64,';
    const smLineStart = bundle.code.lastIndexOf('\n' + SOURCEMAP_LINE_PREFIX);
    t.not(smLineStart, -1, 'Bundle should contain an inline source map');
    const codeOnly = bundle.code.slice(0, smLineStart);
    const sourcemapBase64 = bundle.code.slice(smLineStart + 1 + SOURCEMAP_LINE_PREFIX.length).trimEnd();

    // Check code size (excluding inline source map).
    // As of April 2026, I get ~440 KB for the bundle excluding inlined source map.
    // Some increase is expected over time as we'll continue adding more features to the SDK, but
    // large sudden increases likely indicate we're importing in the bundle something we shouldn't.
    const codeSizeKB = Buffer.byteLength(codeOnly, 'utf-8') / 1024;
    t.log(`Bundle code size: ${codeSizeKB.toFixed(0)} KB`);
    t.true(
      codeSizeKB < 600,
      `Bundle code size (${codeSizeKB.toFixed(0)} KB) exceeds 600 KB — ` +
        `either @temporalio/proto was pulled in, or another unexpectedly large dependency was added`
    );

    // Parse the inline source map to enumerate bundled source files.
    const sourceMap: { sources: string[] } = JSON.parse(Buffer.from(sourcemapBase64, 'base64').toString('utf-8'));
    const sources = sourceMap.sources.slice().sort();

    // Log the full list for manual review (visible in verbose mode or on test failure).
    t.log(`\nSources included in bundle (${sources.length} files):`);
    for (const source of sources) {
      t.log(`  ${source}`);
    }

    // Ensure there is no trace of @temporalio/proto in the bundle.
    const protoSources = sources.filter((s) => s.includes('/packages/proto/') || s.includes('@temporalio/proto'));
    t.deepEqual(protoSources, [], `@temporalio/proto must not appear in workflow bundle sources.}`);
  });

  // Regression test for https://github.com/temporalio/sdk-typescript/issues/2188:
  // module state must remain isolated even when a pre-bundled dependency (shipping
  // its own nested `__webpack_module_cache__`) is included in the Workflow bundle.
  test('Workflow bundle keeps module state isolated with a pre-bundled dependency (#2188)', async (t) => {
    const taskQueue = `${t.title}-${randomUUID()}`;
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/workflow-with-prebundled-dep'),
    });
    const client = new Client();
    const worker = await Worker.create({ taskQueue, reuseV8Context: true, workflowBundle });
    const results = await worker.runUntil(async () => {
      const first = await client.workflow.execute(workflowWithPrebundledDep, { taskQueue, workflowId: randomUUID() });
      const second = await client.workflow.execute(workflowWithPrebundledDep, { taskQueue, workflowId: randomUUID() });
      return [first, second];
    });
    t.deepEqual(results, [1, 1]);
  });

  // Regression test for https://github.com/temporalio/sdk-typescript/issues/2170#issuecomment-4925636742:
  // module state must remain isolated even when the bundle is minified after webpack.
  test('Workflow bundle keeps module state isolated when minified after webpack (#2170 (comment))', async (t) => {
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/preload-shared-counter'),
      webpackConfigHook: (config) => {
        config.plugins = [...(config.plugins ?? []), new ModuleCacheWhitespaceCollapsePlugin()];
        return config;
      },
    });

    t.deepEqual(await runPreloadSharedCounter(t, { workflowBundle }), [1, 1]);
  });
}

// Regression test for https://github.com/temporalio/sdk-typescript/issues/2188:
// a dependency that ships its own pre-bundled webpack runtime carries a nested,
// private `__webpack_module_cache__`. The bundler must redirect only the top-level
// runtime's cache to the injected global, and leave the nested one untouched.
test('Workflow bundle redirects the module cache with a pre-bundled dependency (#2188)', async (t) => {
  const { code } = await bundleWorkflowCode({
    workflowsPath: require.resolve('./workflows/workflow-with-prebundled-dep'),
  });
  // The top-level runtime cache is redirected to the runtime-injected global...
  t.true(code.includes('globalThis.__webpack_module_cache__'), 'top-level module cache should be redirected');
  // ...while the dependency's nested, private cache is left untouched (still `= {}`), and
  // is the only remaining bare initializer.
  const remainingBareInitializers = code.match(/__webpack_module_cache__ = \{\}/g) ?? [];
  t.is(remainingBareInitializers.length, 1, 'the nested private cache should be left untouched');
});

// Regression test for https://github.com/temporalio/sdk-typescript/issues/2170:
// when the bundle is post-processed by a minifier, a text find-and-replace over
// the final output no longer matches. The redirection must happen inside the
// render pipeline, before minification.
test('Workflow bundle redirects the module cache when minified after webpack (#2170)', async (t) => {
  const { code } = await bundleWorkflowCode({
    workflowsPath: require.resolve('./workflows/preload-shared-counter'),
    webpackConfigHook: (config) => {
      config.plugins = [...(config.plugins ?? []), new ModuleCacheWhitespaceCollapsePlugin()];
      return config;
    },
  });
  t.true(code.includes('globalThis.__webpack_module_cache__'), 'module cache should be redirected before minification');
});

/**
 * A webpack plugin that mimics a minifier (e.g. terser) added by a user through
 * `webpackConfigHook`: it rewrites the emitted bundle at the same `processAssets`
 * stage terser uses, collapsing the `__webpack_module_cache__ = {}` declaration
 * to `__webpack_module_cache__={}`. This is enough to defeat a naive text
 * find-and-replace run over the final bundle.
 *
 * See https://github.com/temporalio/sdk-typescript/issues/2170#issuecomment-4925636742.
 */
class ModuleCacheWhitespaceCollapsePlugin {
  apply(compiler: any): void {
    const { Compilation, sources } = compiler.webpack;

    compiler.hooks.compilation.tap('ModuleCacheWhitespaceCollapse', (compilation: any) => {
      compilation.hooks.processAssets.tap(
        { name: 'ModuleCacheWhitespaceCollapse', stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE },

        (assets: any) => {
          for (const name of Object.keys(assets)) {
            if (!name.endsWith('.js')) continue;
            const asset = assets[name];
            const code = asset.source().toString();
            // Use a ReplaceSource (rather than a fresh RawSource) so the source-map chain
            // is preserved for the downstream inline-source-map devtool step.
            const replaced = new sources.ReplaceSource(asset);
            const re = /(var|let|const) __webpack_module_cache__ = \{\}/g;
            for (let m = re.exec(code); m !== null; m = re.exec(code)) {
              replaced.replace(m.index, m.index + m[0].length - 1, `${m[1]} __webpack_module_cache__={}`);
            }
            assets[name] = replaced;
          }
        }
      );
    });
  }
}
