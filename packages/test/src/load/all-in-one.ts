import path from 'node:path';
import { ChildProcess, spawn } from 'node:child_process';
import arg from 'arg';
import { waitOnChild, shell, ChildProcessError, killIfExists } from './child-process';
import { setupArgSpec, starterArgSpec, workerArgSpec, allInOneArgSpec } from './args';

export function addDefaults(args: arg.Result<any>): arg.Result<any> {
  const now = new Date().toISOString();
  return {
    '--server-address': '127.0.0.1:7233',
    '--ns': `load-${now}`,
    '--task-queue': `load-${now}`,
    ...args,
  };
}

function argsToForward(spec: arg.Spec, args: arg.Result<arg.Spec>): string[] {
  return Object.entries(spec)
    .map(([k]) => [k, args[k] === undefined ? undefined : String(args[k])])
    .filter((kv): kv is [string, string] => kv[1] !== undefined)
    .flat();
}

async function waitAndKillSibling(proc: ChildProcess, sibling: ChildProcess) {
  let shouldKillSibling = true;
  try {
    await waitOnChild(proc);
  } catch (err) {
    // If proc was killed by SIGINT we expect sibling to be killed too
    if (err instanceof ChildProcessError && err.signal === 'SIGINT') {
      shouldKillSibling = false;
    } else {
      throw err;
    }
  } finally {
    if (shouldKillSibling) {
      await killIfExists(sibling);
    }
  }
}

async function main() {
  const args = addDefaults(arg(allInOneArgSpec));

  const setupArgs = argsToForward(setupArgSpec, args);
  const setup = spawn('node', [path.resolve(__dirname, 'setup.js'), ...setupArgs], { shell, stdio: 'inherit' });
  await waitOnChild(setup);

  const workerArgs = argsToForward(workerArgSpec, args);
  const inspectArgs = args['--inspect'] ? ['--inspect'] : [];
  const worker = spawn('node', [...inspectArgs, path.resolve(__dirname, 'worker.js'), ...workerArgs], {
    shell,
    stdio: 'inherit',
  });

  const starterArgs = argsToForward(starterArgSpec, args);
  const starter = spawn(
    'node',
    [path.resolve(__dirname, 'starter.js'), '--worker-pid', `${worker.pid ?? ''}`, ...starterArgs],
    { shell, stdio: 'inherit' }
  );

  process.once('SIGINT', () => {
    killIfExists(worker, 'SIGINT').catch(() => /* ignore */ undefined);
    killIfExists(starter, 'SIGINT').catch(() => /* ignore */ undefined);
  });

  const results = await Promise.allSettled([waitAndKillSibling(starter, worker), waitAndKillSibling(worker, starter)]);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(({ reason }) => reason);

  if (errors.length > 0) {
    throw new Error(errors.map((err) => `${err}`).join('\n'));
  }

  console.log('\nCompletely done');
}

main().catch((err) => {
  console.error('Load all-in-one caught error', err);
  process.exit(1);
});
