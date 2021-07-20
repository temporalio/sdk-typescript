import path from 'path';
import arg from 'arg';
import { waitOnChild, shell, kill } from './utils';
import { setupArgSpec, starterArgSpec, workerArgSpec } from './args';
import { spawn } from 'child_process';

export function addDefaults(args: arg.Result<any>): arg.Result<any> {
  const now = new Date().toISOString();
  return {
    '--server-address': 'localhost:7233',
    '--ns': `perf-${now}`,
    '--task-queue': `perf-${now}`,
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

  try {
    const starterArgs = argsToForward(starterArgSpec, args);
    const starter = spawn('node', [path.resolve(__dirname, 'starter.js'), ...starterArgs], { shell, stdio: 'inherit' });
    await waitOnChild(starter);
  } finally {
    await kill(worker);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
