const { isPromise } = require('node:util/types');
const { getPrebuiltPath } = require('./common');
const typescriptExports = require('./lib/index');
const { convertFromNamedError } = require('./lib/errors');

/**
 * Wraps calls to native functions to convert "named errors" to the correct error types.
 */
function wrapErrors(fn) {
  return (...args) => {
    try {
      let res = fn(...args);
      if (isPromise(res)) {
        return res.catch((e) => {
          throw convertFromNamedError(e, false);
        });
      }
      return res;
    } catch (e) {
      throw convertFromNamedError(e, true);
    }
  };
}
let wrapper = (f) => wrapErrors(f);

/**
 * Wraps calls to native functions to add tracing logs.
 *
 * To enable, set the `TEMPORAL_TRACE_NATIVE_CALLS` environment variable to `true`.
 *
 * IMPORTANT: This is meant for internal SDK debugging only.
 */
if (process.env.TEMPORAL_TRACE_NATIVE_CALLS?.toLowerCase() === 'true') {
  // Generate a random 5-character ID for the current "execution"
  let execId = Math.random().toString(36).slice(-5);
  let callSequence = 100000;

  function log(callid, msg) {
    console.log(`${new Date().toISOString()} [call-to-bridge] ${callid} ${msg}`);
  }

  // Do not trace these functions, they are way too verbose
  const ignoreList = ['get_time_of_day'];

  function wrapDebug(fn, fnname) {
    // Functions names looks like `temporal_sdk_typescript_bridge::logs::get_time_of_day`
    // Strip the path to retain only the function name
    fnname = fnname.substring(fnname.lastIndexOf('::') + 2);
    if (ignoreList.includes(fnname)) return fn;

    return (...args) => {
      let callid = `${execId}:${String(callSequence++).slice(-5)}`;

      try {
        log(callid, `${fnname}() - calling in`);

        let res = fn(...args);

        if (isPromise(res)) {
          log(callid, `${fnname}() - received promise`);
          return res.then(
            (x) => {
              log(callid, `${fnname}() - promise resolved`);
              return x;
            },
            (e) => {
              log(callid, `${fnname}() - promise rejected with ${e}`);
              throw convertFromNamedError(e, false);
            }
          );
        } else {
          log(callid, `${fnname}() - returned`);
        }

        return res;
      } catch (e) {
        log(callid, `${fnname}() - threw an error ${e}`);
        throw convertFromNamedError(e, true);
      }
    };
  }

  wrapper = (f) => wrapDebug(wrapErrors(f), f.name);
}

try {
  const nativeLibPath = getPrebuiltPath();
  const native = Object.fromEntries(Object.entries(require(nativeLibPath)).map(([name, fn]) => [name, wrapper(fn)]));
  module.exports = { ...typescriptExports, native };
} catch (err) {
  throw err;
}
