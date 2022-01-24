// Don't use `export default` because then `require('assert')` will be `{ default: assertFn }`. It needs to be `assertFn`.
module.exports = (global as any).assert;
