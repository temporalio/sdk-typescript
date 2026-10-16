import { spawnSync } from 'node:child_process';
import test from 'ava';

// Run in a child process so that the module cache only holds what the given expression loaded.
function modulesLoadedBy(expression: string): string[] {
  const script = `
    Promise.resolve(${expression})
      .catch(() => undefined)
      .then(() => process.stdout.write(JSON.stringify(Object.keys(require.cache))));
  `;
  const { status, stdout, stderr } = spawnSync(process.execPath, ['-e', script], { cwd: __dirname, encoding: 'utf8' });
  if (status !== 0) throw new Error(`Child process exited with status ${status}: ${stderr}`);
  return JSON.parse(stdout);
}

const isBundlerModule = (filename: string) =>
  /[\\/]node_modules[\\/]webpack[\\/]/.test(filename) || /[\\/]workflow[\\/]bundler\.js$/.test(filename);

test('Importing @temporalio/worker does not load the Workflow bundler', (t) => {
  const loaded = modulesLoadedBy(`require('@temporalio/worker')`);
  t.deepEqual(loaded.filter(isBundlerModule), []);
});

test('bundleWorkflowCode loads the Workflow bundler on first use', (t) => {
  const loaded = modulesLoadedBy(`require('@temporalio/worker').bundleWorkflowCode({ workflowsPath: __filename })`);
  t.true(loaded.some(isBundlerModule));
});
