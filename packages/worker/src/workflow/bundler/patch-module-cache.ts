import type { Compiler, Compilation } from 'webpack';
import { javascript, sources, WebpackError } from 'webpack';

type Source = sources.Source;

const PLUGIN_NAME = 'TemporalWorkflowModuleCachePlugin';

/**
 * The runtime-injected global that holds the Workflow bundle's module cache.
 *
 * When running Workflows in a reusable V8 context, the Worker injects an object under this
 * name into the sandbox global (see `reusable-vm.ts`). Redirecting webpack's module cache
 * to this global is what makes per-Workflow module isolation possible while sharing a
 * single V8 context.
 */
const MODULE_CACHE_GLOBAL = 'globalThis.__webpack_module_cache__';

/**
 * A fixed, high-entropy marker that we inject into the top-level webpack runtime's
 * `__webpack_require__` function body.
 *
 * The marker is used to reliably locate the *real* (top-level) module-cache declaration
 * emitted by this run of webpack (vs nested dependencies that have themselves been
 * bundled with webpack and thus carry their own module cache declarations).The marker
 * is stripped from the bundle before the final output is produced, so it never ships.
 *
 * It is intentionally a *stable constant* (not randomly generated per build): the marker
 * participates in webpack's chunk/`[fullhash]` computation, so a random value would make
 * the bundle's content hash — and therefore its filename — non-deterministic across
 * otherwise-identical builds.
 */
const MODULE_CACHE_MARKER = '__temporal_module_cache_marker_5f2e9c8a1b7d4e60a3__';
const MARKER_COMMENT = `/* ${MODULE_CACHE_MARKER} */\n`;

// Matches webpack's top-level module-cache initializer, regardless of the declaration
// keyword used (webpack < 5.108 emits `var`; >= 5.108 may emit `const`, 'let' or `var`).
const MODULE_CACHE_DECLARATION = /(?:var|let|const)\s+__webpack_module_cache__\s*=\s*\{\}/g;

/**
 * Webpack plugin that redirects the Workflow bundle's top-level module cache to a
 * runtime-injected global (`globalThis.__webpack_module_cache__`).
 *
 * This plugin operates inside the webpack render pipeline using in two phases:
 *   1. `renderRequire` injects a stable marker into the top-level runtime's
 *      `__webpack_require__` body. That hook is only ever invoked for the bundle's own
 *      runtime, so the marker unambiguously identifies the real module cache — nested,
 *      pre-bundled runtimes carry their own already-rendered require functions and never
 *      pass through this hook.
 *   2. `renderMain` uses the marker to locate the top-level module-cache declaration
 *      (the nearest one preceding the marker), redirects it to the injected global, and
 *      strips the marker. This runs during chunk rendering — before any `processAssets`
 *      stage, hence before minification — and returns a `ReplaceSource` so source maps
 *      are preserved.
 */
export class InjectWorkflowModuleCacheGlobalPlugin {
  apply(compiler: Compiler): void {
    compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation: Compilation) => {
      const hooks = javascript.JavascriptModulesPlugin.getCompilationHooks(compilation);

      hooks.renderRequire.tap(PLUGIN_NAME, (code: string) => {
        return `${MARKER_COMMENT}${code}`;
      });

      hooks.renderMain.tap(PLUGIN_NAME, (source: Source) => {
        return this.redirectModuleCache(source);
      });
    });
  }

  private redirectModuleCache(source: Source): Source {
    const code = source.source().toString();

    // We're only interested in the chunk that carries the top-level runtime marker
    const markerIndex = code.indexOf(MARKER_COMMENT);
    if (markerIndex === -1) {
      return source;
    }

    // The marker is injected exactly once, into the single top-level
    // require function. Confirm there isn't another marker in the code.
    if (code.indexOf(MARKER_COMMENT, markerIndex + MARKER_COMMENT.length) !== -1) {
      throw new WebpackError(
        `Failed to patch the Workflow bundle: expected exactly one module-cache marker, but found more than one. ` +
          `This is likely due to a change in webpack output; please report this at ` +
          `https://github.com/temporalio/sdk-typescript/issues`
      );
    }

    // The top-level module-cache declaration is the one immediately preceding the marked
    // require function. Any other `__webpack_module_cache__ = {}` occurrences belong to
    // nested, pre-bundled dependencies and appear earlier in the emitted module content, so
    // the nearest match before the marker is always the real one.
    let declaration: RegExpExecArray | null = null;
    // Because of the `/g` flag, the regexp is stateful. We must reset the regexp's
    // lastIndex to 0 to make sure it starts from the beginning of the code, rather
    // than continuing from the last match position of a previous iteration.
    MODULE_CACHE_DECLARATION.lastIndex = 0;
    for (let match = MODULE_CACHE_DECLARATION.exec(code); match !== null; match = MODULE_CACHE_DECLARATION.exec(code)) {
      if (match.index >= markerIndex) break;
      declaration = match;
    }

    if (declaration === null) {
      throw new WebpackError(
        `Failed to patch the Workflow bundle: found the module-cache marker but no preceding ` +
          `'__webpack_module_cache__' declaration to redirect. Without this patch, Workflow isolation ` +
          `would be broken. This is likely due to a change in webpack output; please report this at ` +
          `https://github.com/temporalio/sdk-typescript/issues`
      );
    }

    const replaced = new sources.ReplaceSource(source);

    // Redirect the top-level declaration to the runtime-injected global.
    const declStart = declaration.index;
    const declEndInclusive = declStart + declaration[0].length - 1;
    replaced.replace(declStart, declEndInclusive, declaration[0].replace('= {}', `= ${MODULE_CACHE_GLOBAL}`));

    // Strip the marker so it never ships.
    // Note that `ReplaceSource.replace()` takes character indices from the
    // _original_ source; there's thereforre no need to adjust the indices to
    // account for the replacement we just performed (`= {}` => MODULE_CACHE_GLOBAL).
    let markerEndInclusive = markerIndex + MARKER_COMMENT.length - 1;
    replaced.replace(markerIndex, markerEndInclusive, '');

    return replaced;
  }
}

/**
 * Asserts that the generated Workflow bundle has been correctly patched to redirect the
 * module cache to the runtime-injected global (`globalThis.__webpack_module_cache__`)
 * by `InjectWorkflowModuleCacheGlobalPlugin`.
 *
 * These sanity checks are meant to catch and fail loudly on some specific eventual regressions
 * in the webpack library or configuration that would prevent hijacking webpack's module cache,
 * and thus result in silent reoccurences of #2170 or #2188.
 */
export function assertWorkflowModuleCacheGlobalApplied(code: string): void {
  // Webpack's bootstrap code should contain a declaration of the module cache, similar to:
  //     const __webpack_module_cache__ = {};
  //
  // That line should have been replaced by `InjectWorkflowModuleCacheGlobalPlugin` to:
  //     const __webpack_module_cache__ = globalThis.__webpack_module_cache__;
  //
  // Further webpack plugins (e.g. minification) might further transform that line (e.g. removing
  // spaces or renaming the scoped variable), but the global variable should remain unchanged.
  // Absence of references to that global variable would be an error.
  if (!code.includes(MODULE_CACHE_GLOBAL)) {
    throw new Error(
      `Failed to patch the Workflow bundle: the module cache was not redirected to ` +
        `'${MODULE_CACHE_GLOBAL}'. Without this, Workflow isolation would be broken.` +
        `This may be the result of uncommon and unsupported webpack configurations, ` +
        `but most likely indicates a change in webpack's output format or a bug in the ` +
        `Temporal SDK. Please report this at https://github.com/temporalio/sdk-typescript/issues.`
    );
  }

  // There could be multiple occurences of "__webpack_module_cache__" in the code produced
  // by webpack if the bundle contains nested, pre-bundled dependencies (see #2188).
  // To correctly determine the one to be rewritten, `InjectWorkflowModuleCacheGlobalPlugin`
  // temporarily injects a marker into the top-level runtime's `__webpack_require__` function
  // body. The marker is stripped from the bundle before the final output is produced.
  //
  // The marker being still present in the final bundle code, though unharmful by itself,
  // would be unexpected and should raise doubts about the correctness of the module cache
  // rewrite process.
  if (code.includes(MODULE_CACHE_MARKER)) {
    throw new Error(
      `Failed to patch the Workflow bundle: the internal module-cache marker was ` +
        `not stripped from the output. There's a risk that Workflow isolation would be broken.` +
        `This may be the result of uncommon and unsupported webpack configurations, ` +
        `but most likely indicates a change in webpack's output format or a bug in the ` +
        `Temporal SDK. Please report this at https://github.com/temporalio/sdk-typescript/issues.`
    );
  }
}
