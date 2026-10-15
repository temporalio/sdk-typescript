// Run from either compatibility package, including a clean installation of its tarball.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const packagePath = join(process.cwd(), 'package.json');
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
const requireFromPackage = createRequire(packagePath);
const targets = {
  '@temporalio/ai-sdk': '@temporalio/vercel-ai-sdk',
  '@temporalio/google-adk-agents': '@temporalio/google-adk',
};
const target = targets[pkg.name];
const typeNames =
  pkg.name === '@temporalio/ai-sdk'
    ? ['AiSdkPluginOptions', 'TemporalProviderOptions']
    : ['GoogleAdkPluginOptions', 'TemporalModelOptions', 'MockMCPToolDefinition'];
assert.ok(target, 'Run this test from a compatibility package');
assert.deepEqual(Object.keys(pkg.dependencies), [target]);

for (const subpath of Object.keys(pkg.exports)) {
  const suffix = subpath === '.' ? '' : subpath.slice(1);
  test(`${pkg.name}${suffix} preserves CommonJS and ESM exported bindings`, async () => {
    const expected = requireFromPackage(target + suffix);
    const legacy = requireFromPackage(pkg.name + suffix);
    const esm = await import(pathToFileURL(requireFromPackage.resolve(pkg.name + suffix)).href);
    assert.deepEqual(Object.keys(legacy).sort(), Object.keys(expected).sort());
    for (const name of Object.keys(expected)) {
      assert.equal(legacy[name], expected[name], `CommonJS binding ${name}`);
      assert.equal(esm[name], expected[name], `ESM binding ${name}`);
    }
  });
}

test(`${pkg.name} preserves types through legacy and modern TypeScript resolution`, () => {
  const directory = mkdtempSync(join(process.cwd(), '.compatibility-'));
  try {
    const declarations = Object.keys(pkg.exports).flatMap((subpath, index) => {
      const suffix = subpath === '.' ? '' : subpath.slice(1);
      return [
        `import * as old${index} from '${pkg.name}${suffix}';`,
        `import * as new${index} from '${target}${suffix}';`,
        `const forward${index}: typeof new${index} = old${index};`,
        `const backward${index}: typeof old${index} = new${index};`,
        `type Assignable${index}<T, U extends T> = U;`,
        `type ForwardType${index} = Assignable${index}<new${index}.${typeNames[index]}, old${index}.${typeNames[index]}>;`,
        `type BackwardType${index} = Assignable${index}<old${index}.${typeNames[index]}, new${index}.${typeNames[index]}>;`,
      ];
    });
    const file = join(directory, 'consumer.ts');
    writeFileSync(file, declarations.join('\n'));
    const compiler = require.resolve('typescript/bin/tsc');
    for (const [module, resolution] of [
      ['commonjs', 'node'],
      ['node16', 'node16'],
    ]) {
      execFileSync(
        process.execPath,
        [
          compiler,
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          '--target',
          'ES2022',
          '--module',
          module,
          '--moduleResolution',
          resolution,
          file,
        ],
        { stdio: 'pipe' }
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  `${pkg.name}/workflow runs through the forwarded plugin in the Workflow sandbox`,
  { timeout: 120_000 },
  async () => {
    const { Worker } = requireFromPackage('@temporalio/worker');
    const { TestWorkflowEnvironment } = requireFromPackage('@temporalio/testing');
    const legacy = requireFromPackage(pkg.name);
    const plugin =
      pkg.name === '@temporalio/ai-sdk'
        ? new legacy.AiSdkPlugin({ modelProvider: { specificationVersion: 'v4' } })
        : new legacy.GoogleAdkPlugin();
    const directory = mkdtempSync(join(process.cwd(), '.compatibility-'));
    let environment;
    try {
      const file = join(directory, 'workflows.cjs');
      writeFileSync(
        file,
        `const legacy = require('${pkg.name}/workflow');
       const current = require('${target}/workflow');
       exports.compatibilityWorkflow = async () => {
         const names = Object.keys(current);
         if (!names.length || names.some(name => legacy[name] !== current[name])) {
           throw new Error('Forwarded Workflow bindings differ');
         }
         return true;
       };`
      );
      environment = await TestWorkflowEnvironment.createLocal();
      const taskQueue = `ai-compatibility-${randomUUID()}`;
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        taskQueue,
        workflowsPath: file,
        plugins: [plugin],
      });
      const result = await worker.runUntil(
        environment.client.workflow.execute('compatibilityWorkflow', { taskQueue, workflowId: randomUUID() })
      );
      assert.equal(result, true);
    } finally {
      try {
        await environment?.teardown();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
);
