import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ExecutionContext } from 'ava';
import test from 'ava';
import * as ts from 'typescript';
import { bundleWorkflowCode, DefaultLogger } from '@temporalio/worker';

async function makeWorkflow(t: ExecutionContext, libDir: string, modulePath: string, symbol: string): Promise<string> {
  const dir = await mkdtemp(path.join(libDir, 'otel-entrypoints-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'workflow.ts');
  await writeFile(
    filename,
    `import { ${symbol} } from ${JSON.stringify(modulePath)};
export async function smoke() { return typeof ${symbol}; }
`
  );
  return filename;
}

for (const name of ['interceptors-opentelemetry', 'interceptors-opentelemetry-v2']) {
  const packageName = `@temporalio/${name}`;
  const libDir = path.resolve(__dirname, '../../../contrib', name, 'lib');
  const packageRequire = createRequire(path.join(libDir, 'index.js'));
  const logger = new DefaultLogger('ERROR');

  test(`${packageName}: new and legacy imports resolve under both TypeScript resolvers`, async (t) => {
    const dir = await mkdtemp(path.join(libDir, 'otel-types-'));
    t.teardown(() => rm(dir, { recursive: true, force: true }));
    const scopeDir = path.join(dir, 'node_modules', '@temporalio');
    await mkdir(scopeDir, { recursive: true });
    await symlink(path.dirname(libDir), path.join(scopeDir, name), 'junction');

    for (const moduleResolution of [ts.ModuleResolutionKind.Node10, ts.ModuleResolutionKind.Node16]) {
      for (const subpath of [
        '',
        '/workflow',
        '/lib/workflow',
        '/lib/workflow/index',
        '/lib/workflow/index.js',
        '/lib/client',
        '/lib/worker',
        '/lib/workflow-interceptors',
        '/lib/instrumentation',
        '/lib/workflow/definitions',
      ]) {
        const modulePath = `${packageName}${subpath}`;
        const { resolvedModule } = ts.resolveModuleName(
          modulePath,
          path.join(dir, 'consumer.ts'),
          { moduleResolution },
          ts.sys
        );
        t.truthy(resolvedModule, `${modulePath} under ${ts.ModuleResolutionKind[moduleResolution]}`);
      }
    }
  });

  test(`${packageName}: legacy lib imports resolve to the same files`, (t) => {
    t.is(packageRequire.resolve(`${packageName}/workflow`), packageRequire.resolve(`${packageName}/lib/workflow`));
    for (const directory of ['workflow', 'client', 'worker']) {
      const expected = path.join(libDir, directory, 'index.js');
      for (const subpath of [`lib/${directory}`, `lib/${directory}/index`, `lib/${directory}/index.js`]) {
        t.is(packageRequire.resolve(`${packageName}/${subpath}`), expected);
      }
    }
    t.is(
      packageRequire.resolve(`${packageName}/lib/workflow-interceptors`),
      path.join(libDir, 'workflow-interceptors.js')
    );
    t.is(
      packageRequire.resolve(`${packageName}/lib/workflow-interceptors.js`),
      path.join(libDir, 'workflow-interceptors.js')
    );
  });

  for (const subpath of ['/workflow', '/lib/workflow', '/lib/workflow/index.js', '']) {
    const modulePath = `${packageName}${subpath}`;
    test(`${modulePath}: bundler replaces Workflow import stubs`, async (t) => {
      const workflowsPath = await makeWorkflow(t, libDir, modulePath, 'OpenTelemetryInboundInterceptor');
      let modules: string[] = [];
      await bundleWorkflowCode({
        workflowsPath,
        logger,
        webpackConfigHook(config) {
          config.plugins ??= [];
          config.plugins.push({
            apply(compiler) {
              compiler.hooks.done.tap('CheckOpenTelemetryEntrypoints', (stats) => {
                modules = Array.from(stats.compilation.modules, (module) =>
                  ('resource' in module && typeof module.resource === 'string'
                    ? module.resource
                    : module.identifier()
                  ).replaceAll('\\', '/')
                );
              });
            },
          });
          return config;
        },
      });

      t.true(
        modules.some((id) => /\/workflow\/workflow-imports-impl\.[jt]s/.test(id)),
        modules.filter((id) => id.includes('workflow-imports')).join('\n')
      );
      t.false(modules.some((id) => /\/workflow\/workflow-imports\.[jt]s/.test(id)));
      if (subpath) {
        for (const nonWorkflowModule of ['plugin.js', 'client/index.js', 'worker/index.js']) {
          t.false(modules.some((id) => id.includes(`/${name}/lib/${nonWorkflowModule}`)));
        }
      }
    });
  }

  for (const [directory, symbol] of [
    ['client', 'OpenTelemetryWorkflowClientInterceptor'],
    ['worker', 'OpenTelemetryActivityInboundInterceptor'],
  ] as const) {
    const modulePath = `${packageName}/lib/${directory}`;
    test(`${modulePath}: bundler rejects it unless explicitly ignored`, async (t) => {
      const workflowsPath = await makeWorkflow(t, libDir, modulePath, symbol);
      await t.throwsAsync(bundleWorkflowCode({ workflowsPath, logger }), {
        message: /importing the following disallowed modules/,
      });
      await t.notThrowsAsync(bundleWorkflowCode({ workflowsPath, logger, ignoreModules: [modulePath] }));
    });
  }
}
