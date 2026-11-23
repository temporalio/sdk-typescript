import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import test from 'ava';
import { transformSync } from '@swc/core';
import { webpack } from 'webpack';
import { withActivityReferences } from '../workflow/bundler/activity-reference-plugin';

function compile(source: string): string {
  return transformSync(
    source,
    withActivityReferences({
      filename: 'workflow.ts',
      jsc: { parser: { syntax: 'typescript' }, target: 'es2017' },
    })
  ).code;
}

test('direct calls replace named imports, preserving export names and API aliases', (t) => {
  const source = `
    import { echo as say, type Echo } from './acts';
    import { executeActivity as run, executeLocalActivity } from '@temporalio/workflow';
    export const result = run(say, { args: ['hello'], startToCloseTimeout: '1m' });
    executeLocalActivity(say, { args: ['local'], startToCloseTimeout: '1m' });
  `;
  const withoutPlugin = transformSync(source, {
    jsc: { parser: { syntax: 'typescript' }, target: 'es2017' },
  }).code;
  t.true(withoutPlugin.includes('./acts'));
  t.false(withoutPlugin.includes('createActivityReference'));
  const code = compile(source);
  t.false(code.includes('./acts'));
  t.true(code.includes('const say = __temporal_createActivityReference("echo")'));
  t.true(code.includes('run(say,'));
  t.true(code.includes('executeLocalActivity(say,'));
});

test('explicit imports support factories, forwarding exports, and type queries', (t) => {
  const code = compile(`
    import { echo } from './acts' with { temporal: 'activity' };
    type Echo = typeof echo;
    const factory = (activity: Echo) => () => activity;
    export const forwarded = factory(echo);
    export { echo };
  `);
  t.false(code.includes('./acts'));
  t.false(code.includes('temporal:'));
  t.true(code.includes('factory(echo)'));
  t.true(code.includes('export { echo }'));
});

test('quoted and identifier attribute keys both identify Activity imports', (t) => {
  for (const key of ['temporal', '"temporal"']) {
    const code = compile(`
      import { echo } from './acts' with { ${key}: 'activity' };
      export { echo };
    `);
    t.false(code.includes('./acts'));
    t.true(code.includes('createActivityReference("echo")'));
  }
});

test('shadowed API and Activity bindings are not confused with imports', (t) => {
  const code = compile(`
    import { echo } from './acts';
    import { executeActivity } from '@temporalio/workflow';
    function wrapper(executeActivity: Function) { return executeActivity(echo); }
    function another(echo: Function) { return executeActivity(echo, {}); }
    export { wrapper, another };
  `);
  t.true(code.includes('./acts'));
  t.false(code.includes('createActivityReference'));
});

test('inference ignores type references, shadowed locals, and property names', (t) => {
  const code = compile(`
    import { echo } from './acts';
    import { executeActivity } from '@temporalio/workflow';
    type Echo = typeof echo;
    const unrelated = { echo: 1 };
    function f(echo: string) { return echo; }
    export const result = executeActivity(echo, {});
  `);
  t.false(code.includes('./acts'));
});

test('mixed runtime uses fail with an import-attribute fix and source location', (t) => {
  t.throws(
    () =>
      compile(`import { echo } from './acts';
import { executeActivity } from '@temporalio/workflow';
executeActivity(echo, {});
const wrapped = factory(echo);`),
    { message: /Mark its import with \{ temporal: 'activity' \}/ }
  );
});

test('unrecognized wrapper-only uses retain ordinary imports', (t) => {
  t.true(compile(`import { echo } from './acts'; export const wrapped = factory(echo);`).includes('./acts'));
});

test('mixed import declarations retain non-Activity imports', (t) => {
  const code = compile(`
    import { echo, CONSTANT } from './acts';
    import { executeActivity } from '@temporalio/workflow';
    export const result = executeActivity(echo, { args: [CONSTANT] });
  `);
  t.true(code.includes("import { CONSTANT } from './acts'"));
  t.false(code.includes('import { echo'));
});

test('generated helper names do not collide with user bindings', (t) => {
  const code = compile(`
    import { echo } from './acts' with { temporal: 'activity' };
    export const __temporal_createActivityReference = 'user binding';
    export function f() { return [echo, __temporal_createActivityReference]; }
  `);
  const exports = {} as { f: () => unknown };
  const commonjs = transformSync(code, { module: { type: 'commonjs' } }).code;
  vm.runInNewContext(commonjs, {
    exports,
    require: () => ({ createActivityReference: (name: string) => name }),
  });
  t.deepEqual(JSON.parse(JSON.stringify(exports.f())), ['echo', 'user binding']);
});

for (const declaration of [
  `import echo from './acts' with { temporal: 'activity' }; export { echo };`,
  `import * as acts from './acts' with { temporal: 'activity' }; export { acts };`,
  `import './acts' with { temporal: 'activity' };`,
  `import { echo } from './acts' with { temporal: 'invalid' }; export { echo };`,
]) {
  test(`reject unsupported attribute import: ${declaration}`, (t) => {
    t.throws(() => compile(declaration), { message: /Activity-reference|temporal: 'activity'/ });
  });
}

for (const mode of ['development', 'production'] as const) {
  test(`webpack loader isolates Activity dependencies and Wasm in ${mode} mode`, async (t) => {
    const directory = await mkdtemp(path.join(__dirname, 'activity-references-'));
    t.teardown(() => rm(directory, { recursive: true, force: true }));
    const source = `
    import { echo } from './acts' with { temporal: 'activity' };
    import { executeActivity } from '@temporalio/workflow';
    const factory = (activity: typeof echo) => () =>
      executeActivity(activity, { args: ['hello'], startToCloseTimeout: '1m' });
    export const run = factory(echo);
  `;
    await writeFile(path.join(directory, 'workflow.ts'), source);
    await writeFile(
      path.join(directory, 'acts.ts'),
      `import fs from 'node:fs'; throw new Error('ACTIVITY_IMPLEMENTATION_LOADED'); export async function echo(s: string) { return fs.readFileSync(s); }`
    );
    const compiler = webpack({
      mode,
      experiments: { asyncWebAssembly: true },
      entry: path.join(directory, 'workflow.ts'),
      output: { path: directory, filename: 'bundle.js', library: { type: 'commonjs2' } },
      devtool: 'source-map',
      externals: [/^@temporalio\/workflow/],
      externalsType: 'commonjs',
      resolve: { extensions: ['.ts', '.js'] },
      module: {
        rules: [
          {
            test: /\.ts$/,
            use: {
              loader: require.resolve('../workflow/bundler/activity-reference-loader'),
              options: { sourceMaps: true, jsc: { parser: { syntax: 'typescript' }, target: 'es2017' } },
            },
          },
        ],
      },
    });
    try {
      const stats = await new Promise<import('webpack').Stats>((resolve, reject) => {
        compiler.run((error, stats) => (error ? reject(error) : resolve(stats!)));
      });
      t.false(stats.hasErrors(), stats.toString({ all: false, errors: true }));
      const modules = stats.toJson({ all: false, modules: true }).modules ?? [];
      t.false(modules.some((module) => module.name?.includes('acts.ts') || module.name?.includes('node:fs')));
      t.false(modules.some((module) => module.name?.endsWith('.wasm')));
      const { readFile } = await import('node:fs/promises');
      const code = await readFile(path.join(directory, 'bundle.js'), 'utf8');
      t.false(code.includes('ACTIVITY_IMPLEMENTATION_LOADED'));
      const sourceMap = JSON.parse(await readFile(path.join(directory, 'bundle.js.map'), 'utf8'));
      t.true(sourceMap.sourcesContent.includes(source));
      const module = { exports: {} as { run: () => unknown } };
      vm.runInNewContext(code, {
        module,
        exports: module.exports,
        require: (name: string) =>
          name.endsWith('/internal')
            ? {
                createActivityReference: (name: string) =>
                  Object.assign(
                    () => {
                      throw new Error('called stub');
                    },
                    { activityType: name }
                  ),
              }
            : {
                executeActivity: (activity: { activityType: string }, options: unknown) => [
                  activity.activityType,
                  options,
                ],
              },
      });
      t.deepEqual(JSON.parse(JSON.stringify(module.exports.run())), [
        'echo',
        { args: ['hello'], startToCloseTimeout: '1m' },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => compiler.close((error) => (error ? reject(error) : resolve())));
    }
  });
}
