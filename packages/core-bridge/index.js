const { getPrebuiltPath } = require('./common');
const { IllegalStateError } = require('@temporalio/common');
const typescriptExports = require('./lib/index');

function handleErrors(fn) {
  return (...args) => {
    try {
      const res = fn(...args);
      if (res && typeof res.catch === 'function') {
        return res.catch((e) => {
          switch (e.name) {
            case 'TransportError':
              throw new typescriptExports.TransportError(e.message);
            case 'IllegalStateError':
              throw new IllegalStateError(e.message);
            case 'ShutdownError':
              throw new typescriptExports.ShutdownError(e.message);
            case 'UnexpectedError':
              throw new typescriptExports.UnexpectedError(e.message);
            default: {
              throw e;
            }
          }
        });
      }
      return res;
    } catch (e) {
      switch (e.name) {
        case 'TransportError':
          throw new typescriptExports.TransportError(e.message);
        case 'IllegalStateError':
          throw new IllegalStateError(e.message);
        case 'ShutdownError':
          throw new typescriptExports.ShutdownError(e.message);
        case 'UnexpectedError':
          throw new typescriptExports.UnexpectedError(e.message);
        default: {
          throw e;
        }
      }
    }
  };
}

try {
  const nativeLibPath = getPrebuiltPath();
  const nativeExports = Object.fromEntries(
    Object.entries(require(nativeLibPath)).map(([name, fn]) => [name, handleErrors(fn)])
  );
  module.exports = { ...typescriptExports, ...nativeExports };
} catch (err) {
  throw err;
}
