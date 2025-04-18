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
      if (res instanceof Promise) {
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
 * IMPORTANT: This is meant for internal SDK debugging only.
 *            Always disable this block before committing back to the repo.
 */
// FIXME(JWH): DO NOT COMMIT THIS LINE
if (process.env.TEMPORAL_TRACE_NATIVE_CALLS?.toLowerCase() === 'true') {
  // Generate a random 4-character ID for the current execution
  let execId = Math.random().toString(36).substring(2, 6);
  let callSequence = 100000;

  function wrapDebug(fn, fnname) {
    // Functions names looks like `temporal_sdk_typescript_bridge::logs::get_time_of_day`
    // Strip the path to retain only the function name
    fnname = fnname.substring(fnname.lastIndexOf('::') + 2);

    // Do not trace these functions, they are way too verbose
    const ignored = ['get_time_of_day', 'poll_logs'];
    if (ignored.includes(fnname)) return fn;

    return (...args) => {
      let callid = `${execId}:${String(callSequence++).substring(1)}`;

      try {
        console.log(`${new Date().toISOString()} @@@@ ${callid} ${fnname}() - calling in`);

        let res = fn(...args);

        if (res instanceof Promise) {
          console.log(`${new Date().toISOString()} @@@@ ${callid} ${fnname}() - received promise`);
          return res.then(
            (x) => {
              console.log(`${new Date().toISOString()} @@@@ ${callid} ${fnname}() - promise resolved`);
              return x;
            },
            (e) => {
              console.log(`${new Date().toISOString()} @@@@ ${callid} ${fnname}() - promise rejected with ${e}`);
              throw convertFromNamedError(e, false);
            }
          );
        } else {
          console.log(`${new Date().toISOString()} @@@@ ${callid} ${fnname}() - returned`);
        }

        return res;
      } catch (e) {
        console.log(`${new Date().toISOString()} @@@@ ${callid} ${fnname}() - threw an error ${e}`);
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
