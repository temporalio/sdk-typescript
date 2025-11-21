const { spawn } = require('child_process');

class ChildProcessError extends Error {
  constructor(message, code, signal) {
    super(message);
    this.name = 'ChildProcessError';
    this.code = code;
    this.signal = signal;
  }
}

const shell = /^win/.test(process.platform);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitOnChild(child) {
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

async function kill(child, signal = 'SIGINT') {
  if (process.platform === 'win32') {
    // -PID not supported on Windows
    process.kill(child.pid, signal);
  } else {
    process.kill(-child.pid, signal);
  }

  try {
    await waitOnChild(child);
  } catch (err) {
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

function getSignalNumber(signal) {
  // We don't need any other signals for now, and probably never will, so no need to list them all.
  // But if any other signals ends up being needed, look at `man 3 signal` for the complete list.
  const SIGNAL_NUMBERS = {
    SIGINT: 2,
    SIGTERM: 15,
  };

  if (signal in SIGNAL_NUMBERS) return SIGNAL_NUMBERS[signal];
  throw new TypeError(`Unknown signal in getSignalNumber: '${signal}'. Please add a case for that signal.`);
}

async function spawnNpx(args, opts) {
  const npx = /^win/.test(process.platform) ? 'npx.cmd' : 'npx';
  const npxArgs = ['--prefer-offline', '--timing=true', '--yes', '--', ...args];
  await waitOnChild(spawn(npx, npxArgs, { ...opts, shell }));
}

module.exports = { kill, spawnNpx, waitOnChild, ChildProcessError, shell, sleep };
