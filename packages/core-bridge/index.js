const { getPrebuiltPath } = require('./common');
const typescriptExports = require('./lib/index');
const { convertFromNamedError } = require('./lib/errors');

function wrapErrors(fn) {
  return (...args) => {
    try {
      if (typeof args[args.length - 1] === 'function') {
        const callback = args[args.length - 1];
        args[args.length - 1] = (e, x) => callback(convertFromNamedError(e), x);
      }
      return fn(...args);
    } catch (e) {
      throw convertFromNamedError(e);
    }
  };
}

try {
  const nativeLibPath = getPrebuiltPath();
  const nativeExports = Object.fromEntries(
    Object.entries(require(nativeLibPath)).map(([name, fn]) => [name, wrapErrors(fn)])
  );
  module.exports = { ...typescriptExports, ...nativeExports };
} catch (err) {
  throw err;
}
