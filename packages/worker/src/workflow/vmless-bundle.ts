import { createRequire } from 'node:module';
import assert from 'node:assert';
import { IllegalStateError } from '@temporalio/common';
import type * as Runtime from '@temporalio/workflow/internal/vmless';
import type { Activator } from '@temporalio/workflow/internal';
import type { WorkflowBundleWithSourceMapAndFilename } from './workflow-worker-thread/input';

export interface VmlessBundle extends Runtime.RuntimeModules {
  api: typeof Runtime;
}

/**
 * Evaluate once in a dedicated workflow thread. The only webpack-specific runtime
 * machinery is the existing cache indirection; no global swapping or sandboxing.
 */
export function loadVmlessBundle(bundle: WorkflowBundleWithSourceMapAndFilename): VmlessBundle {
  const sharedModules = new Map<PropertyKey, unknown>();
  let bootstrap = true;
  const cache = new Proxy(
    {},
    {
      get(_, key) {
        if (sharedModules.has(key)) return sharedModules.get(key);
        if (bootstrap) return undefined;
        const activator = loaded.api.maybeGetActivator();
        if (!activator) throw new IllegalStateError('Application module loaded outside workflow execution');
        return activator.moduleCache.get(key as string);
      },
      set(_, key, value) {
        if (bootstrap) {
          sharedModules.set(key, value);
        } else {
          const activator: Activator | undefined = loaded.api.maybeGetActivator();
          if (!activator) throw new IllegalStateError('Application module loaded outside workflow execution');
          activator.moduleCache.set(key as string, value);
        }
        return true;
      },
      deleteProperty(_, key) {
        if (bootstrap) return sharedModules.delete(key);
        const activator = loaded.api.maybeGetActivator();
        if (!activator) throw new IllegalStateError('Application module removed outside workflow execution');
        return activator.moduleCache.delete(key as string);
      },
    }
  );
  Object.defineProperty(globalThis, '__webpack_module_cache__', { value: cache, configurable: true });
  // The existing allowed-builtin shim reads this injected value in both loaders.
  Object.defineProperty(globalThis, 'assert', { value: assert, configurable: true });
  // Function adds two generated lines before its body. Replace the inline map
  // with an offset copy so Node maps exception frames to the original source,
  // rather than a nearby (but incorrect) line. Keep the artifact itself unchanged.
  const sourceMapComment = bundle.code.lastIndexOf('//# sourceMappingURL=data:');
  if (sourceMapComment < 0) throw new TypeError('VM-less bundle is missing its inline source map');
  const code = bundle.code.slice(0, sourceMapComment);
  const sourceMap = Buffer.from(
    JSON.stringify({
      ...bundle.sourceMap,
      mappings: `;;${bundle.sourceMap.mappings}`,
    })
  ).toString('base64');
  // The prototype deliberately evaluates trusted bundle code without a VM.
  // oxlint-disable-next-line typescript/no-implied-eval
  const loaded = new Function(
    'require',
    `${code}\nreturn __TEMPORAL__;\n//# sourceURL=${bundle.filename}\n//# sourceMappingURL=data:application/json;base64,${sourceMap}`
  )(createRequire(__filename)) as VmlessBundle;
  bootstrap = false;
  return loaded;
}
