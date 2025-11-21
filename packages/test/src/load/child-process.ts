// TODO: this code is duplicated in the scripts directory, consider moving to external dependency
import { ChildProcess } from 'node:child_process';

export class ChildProcessError extends Error {
  public readonly name = 'ChildProcessError';

  constructor(
    message: string,
    public readonly code: number | null,
    public readonly signal: NodeJS.Signals | null
  ) {
    super(message);
  }
}

export interface WaitOptions {
  validReturnCodes: number[];
}

export async function waitOnChild(child: ChildProcess, opts?: WaitOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    child.on('exit', (code, signal) => {
      if (code !== null && (opts?.validReturnCodes ?? [0]).includes(code)) {
        resolve();
      } else {
        reject(new ChildProcessError('Process failed', code, signal));
      }
    });
    child.on('error', reject);
  });
}

export async function kill(child: ChildProcess, signal: NodeJS.Signals = 'SIGINT', opts?: WaitOptions): Promise<void> {
  if (child.pid === undefined) {
    throw new TypeError('Expected child with pid');
  }
  process.kill(child.pid, signal);
  try {
    await waitOnChild(child, opts);
  } catch (err) {
    // Should error if the error is not a child process error or it is a child
    // process and either the platform is Windows or the signal matches.
    const shouldError = !(err instanceof ChildProcessError) || (process.platform !== 'win32' && err.signal !== signal);
    if (shouldError) {
      throw err;
    }
  }
}

export async function killIfExists(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGINT',
  opts?: WaitOptions
): Promise<void> {
  try {
    await kill(child, signal, opts);
  } catch (err: any) {
    if (err.code !== 'ESRCH') {
      throw err;
    }
  }
}

export const shell = process.platform === 'win32';
