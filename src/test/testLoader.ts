import anyTest, { TestInterface } from 'ava';
import path from 'path';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import { remove, mkdirp, symlink, writeFile, writeJson } from 'fs-extra';
import { LoaderError, findNodeModules, resolveModulePath } from '../loader';

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

test('findNodeModules finds node_modules if they\'re a symlink to a directory', async (t) => {
  const { dir } = t.context;
  const origin = path.resolve(dir, 'origin');
  const nodeModulesDir = path.resolve(dir, 'node_modules');
  await mkdirp(origin);
  // Double symlink just to verify we resolve links recursively
  await symlink(origin, `${origin}-link`);
  await symlink(`${origin}-link`, nodeModulesDir);
  const found = await findNodeModules(path.resolve(dir, 'index.js'), dir);
  t.is(found, nodeModulesDir);
})

test('resolveModulePath resolves relative file without extension', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const relative = path.resolve(dir, 'relative.js');
  await writeFile(relative, '');
  const resolved = await resolveModulePath('./relative', index);
  t.is(resolved, path.resolve(dir, 'relative.js'));
})

test('resolveModulePath resolves relative file with extension', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const relative = path.resolve(dir, 'relative.js');
  await writeFile(relative, '');
  const resolved = await resolveModulePath('./relative.js', index);
  t.is(resolved, path.resolve(dir, 'relative.js'));
})

test('resolveModulePath resolves absolute file without extension', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const absolute = path.resolve(dir, 'absolute.js');
  await writeFile(absolute, '');
  const resolved = await resolveModulePath(path.resolve(dir, 'absolute'), index);
  t.is(resolved, path.resolve(dir, 'absolute.js'));
})

test('resolveModulePath resolves absolute directory without extension', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const modulePath = path.resolve(dir, 'absolute');
  await mkdirp(modulePath);
  await writeFile(path.resolve(modulePath, 'index.js'), '');
  const resolved = await resolveModulePath(modulePath, index);
  t.is(resolved, path.resolve(dir, 'absolute/index.js'));
})

test('resolveModulePath throws if module index.js is a directory and does not contain and index.js file', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const modulePath = path.resolve(dir, 'relative/index.js');
  await mkdirp(modulePath);
  await t.throwsAsync(() => resolveModulePath(modulePath, index), {
    instanceOf: LoaderError,
    message: `Could not find file: ${modulePath}/index.js`
  });
})

test('resolveModulePath throws if tried to import non .js file', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const modulePath = path.resolve(dir, 'relative.cjs');
  await writeFile(modulePath, '');
  await t.throwsAsync(() => resolveModulePath(modulePath, index), {
    instanceOf: LoaderError,
    message: `Only .js files can be imported, got ${modulePath}`
  });
})

test('resolveModulePath resolves module from package.json', async (t) => {
  const { dir } = t.context;
  const index = path.resolve(dir, 'index.js');
  const reactDir = path.resolve(dir, 'node_modules/react');
  await mkdirp(reactDir);
  const reactPackageJson = path.resolve(reactDir, 'package.json');
  const reactIndex = path.resolve(reactDir, 'index.js');
  await writeFile(reactIndex, '');
  await writeJson(reactPackageJson, { module: 'index.js' });
  const resolved = await resolveModulePath('react', index);
  t.is(resolved, reactIndex);
})
