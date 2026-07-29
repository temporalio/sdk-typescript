// This module simulates a dependency that ships its own *pre-bundled* webpack
// output (e.g. `node_modules/ejson/index.js`), carrying its own function-scoped
// `__webpack_module_cache__`. When such a dependency is pulled into a Workflow bundle,
// the emitted bundle ends up containing more than one `__webpack_module_cache__`
// declaration: the real top-level runtime one, plus one (or more) nested, private ones.
//
// See https://github.com/temporalio/sdk-typescript/issues/2188.
function nestedWebpackRuntime(): { greet: () => string } {
  const __webpack_module_cache__: Record<string, any> = {};
  return {
    greet: () => {
      if (__webpack_module_cache__['greeting'] === undefined) {
        __webpack_module_cache__['greeting'] = 'hello from a pre-bundled dependency';
      }
      return __webpack_module_cache__['greeting'];
    },
  };
}

export function greet(): string {
  return nestedWebpackRuntime().greet();
}
