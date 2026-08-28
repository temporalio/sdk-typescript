import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import readline from 'node:readline';

export interface ChildSpec {
  name: string;
  command: string;
  args: string[];
  options?: SpawnOptions;
}

export interface ChildSupervisor {
  completion: Promise<void>;
  shutdown(signal?: NodeJS.Signals): void;
}

function prefixOutput(child: ChildProcess, name: string): void {
  if (child.stdout !== null) {
    readline.createInterface({ input: child.stdout }).on('line', (line) => console.log(`[${name}] ${line}`));
  }
  if (child.stderr !== null) {
    readline.createInterface({ input: child.stderr }).on('line', (line) => console.error(`[${name}] ${line}`));
  }
}

export function startChildSupervisor(specs: readonly ChildSpec[]): ChildSupervisor {
  if (specs.length === 0) {
    throw new Error('At least one child process is required');
  }

  const children = new Map<ChildProcess, string>();
  let stopping = false;
  let failure: Error | undefined;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const finishIfStopped = (): void => {
    if (stopping && children.size === 0) {
      if (failure === undefined) resolveCompletion();
      else rejectCompletion(failure);
    }
  };

  const terminateChildren = (signal: NodeJS.Signals = 'SIGTERM'): void => {
    for (const child of children.keys()) {
      child.kill(signal);
    }
  };

  const fail = (error: Error, exitedChild?: ChildProcess): void => {
    if (failure === undefined) failure = error;
    if (!stopping) {
      stopping = true;
      for (const child of children.keys()) {
        if (child !== exitedChild) child.kill('SIGTERM');
      }
    }
  };

  for (const spec of specs) {
    const child = spawn(spec.command, spec.args, {
      ...spec.options,
      stdio: spec.options?.stdio ?? ['ignore', 'pipe', 'pipe'],
    });
    children.set(child, spec.name);
    prefixOutput(child, spec.name);

    child.once('error', (error) => {
      fail(new Error(`Worker process "${spec.name}" failed to start: ${error.message}`, { cause: error }), child);
    });
    child.once('close', (code, signal) => {
      children.delete(child);
      if (!stopping) {
        fail(
          new Error(
            `Worker process "${spec.name}" exited unexpectedly (${
              signal === null ? `code ${code}` : `signal ${signal}`
            })`
          ),
          child
        );
      }
      finishIfStopped();
    });
  }

  return {
    completion,
    shutdown(signal = 'SIGTERM'): void {
      if (!stopping) {
        stopping = true;
        terminateChildren(signal);
        finishIfStopped();
      }
    },
  };
}
