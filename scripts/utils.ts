import { ChildProcess, spawn, SpawnOptions } from 'node:child_process';

export class ChildProcessError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly signal: NodeJS.Signals | null
  ) {
    super(message);
    this.name = 'ChildProcessError';
  }
}

export const shell = /^win/.test(process.platform);

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitOnChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.on('exit', (code: number, signal: NodeJS.Signals) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new ChildProcessError('Process failed', code, signal as NodeJS.Signals));
      }
    });
    child.on('error', reject);
  });
}

export async function kill(child: ChildProcess, signal: NodeJS.Signals = 'SIGINT'): Promise<void> {
  if (typeof child.pid !== 'number') {
    throw new TypeError('Expected child with pid');
  }

  // -PID not supported on Windows
  if (process.platform === 'win32') {
    process.kill(child.pid, signal);
  } else {
    process.kill(-child.pid, signal);
  }

  try {
    await waitOnChild(child);
  } catch (err: unknown) {
    const signalNumber = getSignalNumber(signal);

    // Ignore the error if it simply indicates process termination due to the signal we just sent.
    // On Unix, a process may complete with exit code 128 + signal number to indicate
    // that it was terminated by a signal. But we have the signal name.
    const shouldIgnore =
      err instanceof ChildProcessError &&
      (process.platform === 'win32' || err.signal === signal || err.code === 128 + signalNumber);

    if (!shouldIgnore) throw err;
  }
}

function getSignalNumber(signal: NodeJS.Signals): number {
  // We don't need any other signals for now, and probably never will, so no need to list them all.
  // But if any other signals ends up being needed, look at `man 3 signal` for the complete list.
  const SIGNAL_NUMBERS = {
    SIGINT: 2,
    SIGTERM: 15,
  } as const satisfies Partial<Record<NodeJS.Signals, number>>;

  if (signal in SIGNAL_NUMBERS) return SIGNAL_NUMBERS[signal];
  throw new TypeError(`Unknown signal in getSignalNumber: '${signal}'. Please add a case for that signal.`);
}

export async function spawnNpx(args: string[], opts: SpawnOptions): Promise<void> {
  const npx = /^win/.test(process.platform) ? 'npx.cmd' : 'npx';
  const npxArgs = ['--prefer-offline', '--timing=true', '--yes', '--', ...args];
  await waitOnChild(spawn(npx, npxArgs, { ...opts, shell }));
}
