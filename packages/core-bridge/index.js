const { getPrebuiltPath } = require('./common');
const typescriptExports = require('./lib/index');
const { convertFromNamedError } = require('./lib/errors');

function wrapErrors(fn) {
  return (...args) => {
    try {
      // Some of our native functions expect callback functions. When present, these callbacks are
      // always the last argument passed to the function, and always adhere to the signature
      // `callback(err, result)`. If a callback is present, then make sure that errors sent
      // to it are also converted.
      if (typeof args[args.length - 1] === 'function') {
        const callback = args[args.length - 1];
        args[args.length - 1] = (e, x) => callback(convertFromNamedError(e, false), x);
      }
      return fn(...args);
    } catch (e) {
      throw convertFromNamedError(e, true);
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
