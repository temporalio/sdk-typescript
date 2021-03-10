import anyTest, { TestInterface } from 'ava';
import path from 'path';
import { tmpdir } from 'os';
import ivm from 'isolated-vm';
import { mkdtemp, remove, mkdirp, symlink, writeFile, writeJson } from 'fs-extra';
import { Loader, LoaderError, findNodeModules, resolveModule } from '@temporalio/worker/lib/loader';

export interface Context {
  dir: string;
}

const test = anyTest as TestInterface<Context>;

test.beforeEach(async (t) => {
  t.context = {
    dir: await mkdtemp(path.join(tmpdir(), 'temporal-sdk-test-')),
  };
});

test.afterEach.always(async (t) => {
  await remove(t.context.dir);
});

test('findNodeModules finds node_modules in same dir', async (t) => {
  const { dir } = t.context;
  const nodeModulesDir = path.resolve(dir, 'node_modules');
  await mkdirp(nodeModulesDir);
  const found = await findNodeModules(path.resolve(dir, 'index.js'), dir);
  t.is(found, nodeModulesDir);
});

test('findNodeModules finds node_modules in parent dir', async (t) => {
  const { dir } = t.context;
  const nodeModulesDir = path.resolve(dir, 'node_modules');
  await mkdirp(nodeModulesDir);
  const codeDir = path.resolve(dir, 'code');
  await mkdirp(codeDir);
  const found = await findNodeModules(codeDir, dir);
  t.is(found, nodeModulesDir);
});

test('findNodeModules throws when node_modules is a file', async (t) => {
  const { dir } = t.context;
  const nodeModulesDir = path.resolve(dir, 'node_modules');
  await writeFile(nodeModulesDir, '');
  const index = path.resolve(dir, 'index.js');
  await t.throwsAsync(() => findNodeModules(index, dir), {
    instanceOf: LoaderError,
    message: `No node_modules directory found from referrer: ${index}`,
  });
});

test('findNodeModules throws when no node_modules in FS root', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  await t.throwsAsync(() => findNodeModules(index, dir), {
    instanceOf: LoaderError,
    message: `No node_modules directory found from referrer: ${index}`,
  });
});

test("findNodeModules finds node_modules if they're a symlink to a directory", async (t) => {
  const { dir } = t.context;
  const origin = path.resolve(dir, 'origin');
  const nodeModulesDir = path.resolve(dir, 'node_modules');
  await mkdirp(origin);
  // Double symlink just to verify we resolve links recursively
  await symlink(origin, `${origin}-link`);
  await symlink(`${origin}-link`, nodeModulesDir);
  const found = await findNodeModules(path.resolve(dir, 'index.js'), dir);
  t.is(found, nodeModulesDir);
});

test('resolveModule resolves relative file without extension', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const relative = path.resolve(dir, 'relative.js');
  await writeFile(relative, '');
  const resolved = await resolveModule('./relative', index, 'esmodule');
  t.is(resolved.path, path.resolve(dir, 'relative.js'), 'esmodule');
});

test('resolveModule resolves relative file with extension', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const relative = path.resolve(dir, 'relative.js');
  await writeFile(relative, '');
  const resolved = await resolveModule('./relative.js', index, 'esmodule');
  t.is(resolved.path, path.resolve(dir, 'relative.js'));
});

test('resolveModule resolves absolute file without extension', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const absolute = path.resolve(dir, 'absolute.js');
  await writeFile(absolute, '');
  const resolved = await resolveModule(path.resolve(dir, 'absolute'), index, 'esmodule');
  t.is(resolved.path, path.resolve(dir, 'absolute.js'));
});

test('resolveModule resolves absolute directory without extension', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const modulePath = path.resolve(dir, 'absolute');
  await mkdirp(modulePath);
  await writeFile(path.resolve(modulePath, 'index.js'), '');
  const resolved = await resolveModule(modulePath, index, 'esmodule');
  t.is(resolved.path, path.resolve(dir, 'absolute/index.js'));
});

test('resolveModule resolves js file even if directory exists', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const moduleDir = path.resolve(dir, 'absolute');
  const moduleFile = path.resolve(dir, 'absolute.js');
  await mkdirp(moduleDir);
  await writeFile(moduleFile, '');
  const resolved = await resolveModule(moduleDir, index, 'esmodule');
  t.is(resolved.path, moduleFile);
});

test('resolveModule throws if module index.js is a directory and does not contain an index.js file', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const modulePath = path.resolve(dir, 'relative/index.js');
  await mkdirp(modulePath);
  await t.throwsAsync(() => resolveModule(modulePath, index, 'esmodule'), {
    instanceOf: LoaderError,
    message: `Could not find file: ${modulePath}/index.js`,
  });
});

test('resolveModule throws if tried to import non .js file', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const modulePath = path.resolve(dir, 'relative.cjs');
  await writeFile(modulePath, '');
  await t.throwsAsync(() => resolveModule(modulePath, index, 'esmodule'), {
    instanceOf: LoaderError,
    message: `Only .js files can be imported, got ${modulePath}`,
  });
});

test('resolveModule resolves module from package.json', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const reactDir = path.resolve(dir, 'node_modules/react');
  await mkdirp(reactDir);
  const reactPackageJson = path.resolve(reactDir, 'package.json');
  const reactIndex = path.resolve(reactDir, 'index.js');
  await writeFile(reactIndex, '');
  await writeJson(reactPackageJson, { module: 'index.js', main: 'not-found.js' });
  const resolved = await resolveModule('react', index, 'esmodule');
  t.is(resolved.path, reactIndex);
  t.is(resolved.type, 'esmodule');
});

test('resolveModule resolves commonjs if only main in package.json', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const reactDir = path.resolve(dir, 'node_modules/react');
  await mkdirp(reactDir);
  const reactPackageJson = path.resolve(reactDir, 'package.json');
  const reactIndex = path.resolve(reactDir, 'index.js');
  await writeFile(reactIndex, '');
  await writeJson(reactPackageJson, { main: 'index.js' });
  const resolved = await resolveModule('react', index, 'esmodule');
  t.is(resolved.path, reactIndex);
  t.is(resolved.type, 'commonjs');
});

test('resolveModule preserves moduleType hint', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const relative = path.resolve(dir, 'relative.js');
  await writeFile(relative, '');
  {
    const resolved = await resolveModule('./relative.js', index, 'esmodule');
    t.is(resolved.type, 'esmodule');
  }
  {
    const resolved = await resolveModule('./relative.js', index, 'commonjs');
    t.is(resolved.type, 'commonjs');
  }
});

test('resolveModuleCallback resolves from base of specifier', async (t) => {
  const isolate = new ivm.Isolate();
  const context = await isolate.createContext();
  const loader = new Loader(isolate, context);

  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const reactDir = path.resolve(dir, 'node_modules/react');
  await mkdirp(reactDir);
  const reactPackageJson = path.resolve(reactDir, 'package.json');
  const reactComponent = path.resolve(reactDir, 'component.js');
  await writeFile(index, 'import "react/component"');
  await writeFile(reactComponent, '');
  await writeJson(reactPackageJson, { main: 'index.js' });
  await loader.loadModule(index, 'esmodule');
  t.pass();
});

test('resolveModuleCallback resolves from base of specifier with scoped package', async (t) => {
  const isolate = new ivm.Isolate();
  const context = await isolate.createContext();
  const loader = new Loader(isolate, context);

  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const reactDir = path.resolve(dir, 'node_modules/@scope/react');
  await mkdirp(reactDir);
  const reactPackageJson = path.resolve(reactDir, 'package.json');
  const reactComponent = path.resolve(reactDir, 'component.js');
  await writeFile(index, 'import "@scope/react/component"');
  await writeFile(reactComponent, '');
  await writeJson(reactPackageJson, { main: 'index.js' });
  await loader.loadModule(index, 'esmodule');
  t.pass();
});
