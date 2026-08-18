/* eslint-disable import/unambiguous */
// We have had historical reasons to allow the `assert` built-in module in Workflow
// code. It is now likely that some user code relies on it, so can't remove it.
// Don't use `export default` because then `require('assert')` will be `{ default: assertFn }`. It needs to be `assertFn`.
module.exports = (global as any).assert;
