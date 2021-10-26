import test from 'ava';
import * as memfs from 'memfs';
import { resolveNodeModulesPaths } from '@temporalio/worker/lib/worker-options';

test('resolveNodeModulesPaths resolves when workflowsPath is a file', (t) => {
  const fs = new memfs.Volume();
  fs.mkdirpSync('/app/project/lib');
  fs.mkdirpSync('/app/project/node_modules');
  fs.writeFileSync('/app/project/lib/workflows.ts', '');
  const paths = resolveNodeModulesPaths(fs as any, '/app/project/lib/workflows.ts');
  t.deepEqual(paths, ['/app/project/node_modules']);
});

test('resolveNodeModulesPaths resolves when workflowsPath is a directory', (t) => {
  const fs = new memfs.Volume();
  fs.mkdirpSync('/app/project/lib/workflows');
  fs.mkdirpSync('/app/project/node_modules');
  const paths = resolveNodeModulesPaths(fs as any, '/app/project/lib/workflows');
  t.deepEqual(paths, ['/app/project/node_modules']);
});

test('resolveNodeModulesPaths throws if not found', (t) => {
  const fs = new memfs.Volume();
  fs.mkdirpSync('/app/project/lib/workflows');
  t.throws(() => resolveNodeModulesPaths(fs as any, '/app/project/lib/workflows'), {
    message: /Failed to automatically locate node_modules relative to given workflowsPath/,
  });
});
