import { greet } from './prebundled-webpack-dep';
import { nextPreloadedCounterValue } from './preload-shared-counter-helper';

// This Workflow pulls a pre-bundled dependency (which ships its own nested
// `__webpack_module_cache__`) into the Workflow bundle, and also relies on
// module-level state (the shared counter) so that Workflow isolation can
// be verified.
//
// See https://github.com/temporalio/sdk-typescript/issues/2188.
export async function workflowWithPrebundledDep(): Promise<number> {
  if (typeof greet() !== 'string') {
    throw new Error('Expected the pre-bundled dependency to return a string');
  }
  return nextPreloadedCounterValue();
}
