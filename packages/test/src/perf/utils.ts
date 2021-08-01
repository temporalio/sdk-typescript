// TODO: this code is duplicated in the scripts directory, consider moving to external dependency
import { ChildProcess } from 'child_process';

export class ChildProcessError extends Error {
  public readonly name = 'ChildProcessError';

  constructor(message: string, public readonly code: number | null, public readonly signal: NodeJS.Signals | null) {
    super(message);
  }
}

export async function waitOnChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new ChildProcessError('Process failed', code, signal));
      }
    });
    child.on('error', reject);
  });
}

export async function kill(child: ChildProcess, signal: NodeJS.Signals = 'SIGINT'): Promise<void> {
  if (child.pid === undefined) {
    throw new TypeError('Expected child with pid');
  }
  process.kill(child.pid, signal);
  try {
    await waitOnChild(child);
  } catch (err) {
    if (!(err.name === 'ChildProcessError' && err.signal === signal)) {
      throw err;
    }
  }
}

export const shell = process.platform === 'win32';
