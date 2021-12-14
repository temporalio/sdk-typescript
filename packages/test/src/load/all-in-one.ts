import path from 'path';
import arg from 'arg';
import { waitOnChild, shell, kill } from '@temporalio/testing/lib/child-process';
import { setupArgSpec, starterArgSpec, workerArgSpec } from './args';
import { spawn } from 'child_process';

export function addDefaults(args: arg.Result<any>): arg.Result<any> {
  const now = new Date().toISOString();
  return {
    '--server-address': 'localhost:7233',
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

async function main() {
  const args = addDefaults(arg({ ...setupArgSpec, ...starterArgSpec, ...workerArgSpec }));

  const setupArgs = argsToForward(setupArgSpec, args);
  const setup = spawn('node', [path.resolve(__dirname, 'setup.js'), ...setupArgs], { shell, stdio: 'inherit' });
  await waitOnChild(setup);

  const workerArgs = argsToForward(workerArgSpec, args);
  const worker = spawn('node', [path.resolve(__dirname, 'worker.js'), ...workerArgs], { shell, stdio: 'inherit' });
  process.once('SIGINT', () => kill(worker, 'SIGINT').catch(() => /* ignore */ undefined));

  try {
    const starterArgs = argsToForward(starterArgSpec, args);
    const starter = spawn(
      'node',
      [path.resolve(__dirname, 'starter.js'), '--worker-pid', `${worker.pid ?? ''}`, ...starterArgs],
      { shell, stdio: 'inherit' }
    );
    worker.on('exit', async (code, signal) => {
      // If worker dies unceremoniously then also make sure we can exit and not hang
      if (code !== 0) {
        console.error('Killing starter because worker exited nonzero', { code, signal });
        await kill(starter, 'SIGINT');
      }
    });
    await waitOnChild(starter);
  } finally {
    await kill(worker);
  }

  console.log('Completely done');
}

main().catch((err) => {
  console.error('Load all-in-one caught error', err);
  process.exit(1);
});
