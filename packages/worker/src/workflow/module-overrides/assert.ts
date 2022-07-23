/* eslint-disable import/unambiguous */
// proto3-json-serializer assumes it's running in Node and that `assert` is present, so we need to add it
// Don't use `export default` because then `require('assert')` will be `{ default: assertFn }`. It needs to be `assertFn`.
module.exports = (global as any).assert;
