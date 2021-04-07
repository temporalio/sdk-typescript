class ChildProcessError extends Error {
  constructor(message, code, signal) {
    super(message);
    this.name = 'ChildProcessError';
    this.code = code;
    this.signal = signal;
  }
}

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
  process.kill(-child.pid, signal);
  try {
    await waitOnChild(child);
  } catch (err) {
    if (!(err.name === 'ChildProcessError' && err.signal === signal)) {
      throw err;
    }
  }
}

const shell = process.platform === 'win32';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { kill, waitOnChild, ChildProcessError, shell, sleep };
