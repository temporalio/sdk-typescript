/** Bundler generation and validation tests that do not require a server. */
import { randomUUID } from 'crypto';
import test from 'ava';
import { moduleMatches, parseWorkflowCode } from '@temporalio/worker/internal';
import pkg from '@temporalio/worker/internal/pkg';
import type { LogEntry } from '@temporalio/worker';
import { bundleWorkflowCode, DefaultLogger, Worker } from '@temporalio/worker';
import { ModuleCacheWhitespaceCollapsePlugin } from './bundler-test-helpers';

test('moduleMatches works', (t) => {
  t.true(moduleMatches('fs', ['fs']));
  t.true(moduleMatches('fs/lib/foo', ['fs']));
  t.false(moduleMatches('fs', ['foo']));
});

class VersionValidationTestWorker extends Worker {
  static workflowCreatorWasCreated = false;

  protected static override async createWorkflowCreator(): Promise<never> {
    this.workflowCreatorWasCreated = true;
    throw new Error('Workflow creator should not be created for an incompatible bundle');
  }
}

test('Workflow bundle contains the SDK version annotation after minification', async (t) => {
  const { code } = await bundleWorkflowCode({
    workflowsPath: require.resolve('./workflows/preload-shared-counter'),
    webpackConfigHook: (config) => ({ ...config, mode: 'production' }),
  });

  const annotation = `/* @temporalio/workflow-bundle ${JSON.stringify({ sdkVersion: pkg.version })} */\n`;
  t.true(code.startsWith(annotation));
  t.notThrows(() => parseWorkflowCode(code));
});

test('Workflow bundle from a different SDK version is rejected', async (t) => {
  const { code } = await bundleWorkflowCode({
    workflowsPath: require.resolve('./workflows/preload-shared-counter'),
  });

  const expectedAnnotation = `/* @temporalio/workflow-bundle ${JSON.stringify({ sdkVersion: pkg.version })} */`;
  const mismatchedAnnotation = `/* @temporalio/workflow-bundle ${JSON.stringify({ sdkVersion: '0.0.0-test' })} */`;
  const mismatchedCode = code.replace(expectedAnnotation, mismatchedAnnotation);

  VersionValidationTestWorker.workflowCreatorWasCreated = false;
  const err = await t.throwsAsync(
    VersionValidationTestWorker.create({
      taskQueue: 'incompatible-workflow-bundle',
      workflowBundle: { code: mismatchedCode },
    }),
    {
      instanceOf: TypeError,
    }
  );
  t.false(VersionValidationTestWorker.workflowCreatorWasCreated);
  t.true(err?.message.includes(`generated with Temporal SDK version '0.0.0-test'`) ?? false);
  t.true(err?.message.includes(`Worker is running version '${pkg.version}'`) ?? false);
});

test('Workflow bundle without an SDK version annotation is rejected despite containing the old cache marker', (t) => {
  const annotation = `/* @temporalio/workflow-bundle ${JSON.stringify({ sdkVersion: pkg.version })} */`;
  const code = `void globalThis.__webpack_module_cache__;\n${annotation}`;

  t.throws(() => parseWorkflowCode(code), {
    instanceOf: TypeError,
    message: /does not contain a Temporal SDK version annotation/,
  });
});

test('Workflow bundle with a malformed SDK version annotation is rejected', (t) => {
  t.throws(() => parseWorkflowCode('/* @temporalio/workflow-bundle invalid */\n'), {
    instanceOf: TypeError,
    message: /contains an invalid Temporal SDK version annotation/,
  });
});

test('An error is thrown when workflow depends on a node built-in module', async (t) => {
  const logs: LogEntry[] = [];
  const logger = new DefaultLogger('WARN', (entry: LogEntry) => {
    logs.push(entry);
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

test('Workflow bundle redirects the module cache regardless of assignment whitespace', async (t) => {
  const { code } = await bundleWorkflowCode({
    workflowsPath: require.resolve('./workflows/preload-shared-counter'),
    webpackConfigHook: (config) => {
      config.plugins = [new ModuleCacheRenderWhitespaceCollapsePlugin(), ...(config.plugins ?? [])];
      return config;
    },
  });

  t.true(code.includes('globalThis.__webpack_module_cache__'), 'module cache should be redirected');
});

/**
 * A webpack plugin that changes the module-cache declaration before Temporal's
 * render-time patch runs. This simulates webpack emitting `__webpack_module_cache__={}`
 * instead of `__webpack_module_cache__ = {}`.
 */
class ModuleCacheRenderWhitespaceCollapsePlugin {
  apply(compiler: any): void {
    compiler.hooks.compilation.tap('ModuleCacheRenderWhitespaceCollapse', (compilation: any) => {
      const hooks = compiler.webpack.javascript.JavascriptModulesPlugin.getCompilationHooks(compilation);

      hooks.renderMain.tap('ModuleCacheRenderWhitespaceCollapse', (source: any) => {
        const code = source.source().toString();
        const replaced = new compiler.webpack.sources.ReplaceSource(source);
        const re = /((?:var|let|const)\s+__webpack_module_cache__)\s*=\s*\{\}/g;
        for (let match = re.exec(code); match !== null; match = re.exec(code)) {
          replaced.replace(match.index, match.index + match[0].length - 1, `${match[1]}={}`);
        }
        return replaced;
      });
    });
  }
}
