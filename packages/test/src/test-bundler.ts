/**
 * Test the various states of a Worker.
 * Most tests use a mocked core, some tests run serially because they emit signals to the process
 */
import { unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join as pathJoin } from 'node:path';
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { moduleMatches } from '@temporalio/worker/lib/workflow/bundler';
import { bundleWorkflowCode, DefaultLogger, LogEntry } from '@temporalio/worker';
import { WorkflowClient } from '@temporalio/client';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { issue516 } from './mocks/workflows-with-node-dependencies/issue-516';
import { successString } from './workflows';
import { workflowWithPrebundledDep } from './workflows/workflow-with-prebundled-dep';

test('moduleMatches works', (t) => {
  t.true(moduleMatches('fs', ['fs']));
  t.true(moduleMatches('fs/lib/foo', ['fs']));
  t.false(moduleMatches('fs', ['foo']));
});

if (RUN_INTEGRATION_TESTS) {
  test('Worker can be created from bundle code', async (t) => {
    const taskQueue = `${t.title}-${uuid4()}`;
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows'),
    });
    const worker = await Worker.create({
      taskQueue,
      workflowBundle,
    });
    const client = new WorkflowClient();
    await worker.runUntil(client.execute(successString, { taskQueue, workflowId: uuid4() }));
    t.pass();
  });

  test('Worker can be created from bundle path', async (t) => {
    const taskQueue = `${t.title}-${uuid4()}`;
    const { code } = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows'),
    });
    const uid = uuid4();
    const codePath = pathJoin(os.tmpdir(), `workflow-bundle-${uid}.js`);
    await writeFile(codePath, code);
    const workflowBundle = { codePath };
    const worker = await Worker.create({
      taskQueue,
      workflowBundle,
    });
    const client = new WorkflowClient();
    try {
      await worker.runUntil(client.execute(successString, { taskQueue, workflowId: uuid4() }));
    } finally {
      await unlink(codePath);
    }
    t.pass();
  });

  test('Workflow bundle can be created from code using ignoreModules', async (t) => {
    const taskQueue = `${t.title}-${uuid4()}`;
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./mocks/workflows-with-node-dependencies/issue-516'),
      ignoreModules: ['dns'],
    });
    const worker = await Worker.create({
      taskQueue,
      workflowBundle,
    });
    const client = new WorkflowClient();
    await worker.runUntil(client.execute(issue516, { taskQueue, workflowId: uuid4() }));
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
    const taskQueue = `${t.title}-${uuid4()}`;
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

  // Regression test for https://github.com/temporalio/sdk-typescript/issues/2188:
  // module state must remain isolated even when a pre-bundled dependency (shipping
  // its own nested `__webpack_module_cache__`) is included in the Workflow bundle.
  test('Workflow bundle keeps module state isolated with a pre-bundled dependency (#2188)', async (t) => {
    const taskQueue = `${t.title}-${uuid4()}`;
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/workflow-with-prebundled-dep'),
    });
    const client = new WorkflowClient();
    const worker = await Worker.create({ taskQueue, reuseV8Context: true, workflowBundle });
    const results = await worker.runUntil(async () => {
      const first = await client.execute(workflowWithPrebundledDep, { taskQueue, workflowId: uuid4() });
      const second = await client.execute(workflowWithPrebundledDep, { taskQueue, workflowId: uuid4() });
      return [first, second];
    });
    t.deepEqual(results, [1, 1]);
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
    workflowsPath: require.resolve('./workflows'),
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
