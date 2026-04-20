// https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options
import type { ChildProcess, SpawnOptions } from 'child_process';
import { spawn as origSpawn } from 'child_process';

export class ChildProcessError extends Error {
  public readonly name = 'ChildProcessError';
  public command?: string;
  public args?: ReadonlyArray<string>;

  constructor(
    message: string,
    public readonly code: number | null,
    public readonly signal: string | null
  ) {
    super(message);
  }
}

export async function spawn(command: string, args?: ReadonlyArray<string>, options?: SpawnOptions): Promise<void> {
  try {
    // Workaround @types/node - avoid choosing overloads per options.stdio variants
    await waitOnChild(options === undefined ? origSpawn(command, args) : origSpawn(command, args || [], options));
  } catch (err) {
    if (err instanceof ChildProcessError) {
      err.command = command;
      err.args = args;
    }
    throw err;
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
