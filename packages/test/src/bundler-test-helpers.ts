/**
 * A webpack plugin that mimics a minifier (e.g. terser) added by a user through
 * `webpackConfigHook`: it rewrites the emitted bundle at the same `processAssets`
 * stage terser uses, collapsing the `__webpack_module_cache__ = {}` declaration
 * to `__webpack_module_cache__={}`. This is enough to defeat a naive text
 * find-and-replace run over the final bundle.
 *
 * See https://github.com/temporalio/sdk-typescript/issues/2170#issuecomment-4925636742.
 */
export class ModuleCacheWhitespaceCollapsePlugin {
  // oxlint-disable-next-line typescript/explicit-module-boundary-types -- Preserve the test plugin's webpack compiler shim.
  apply(compiler: any): void {
    const { Compilation, sources } = compiler.webpack;

    compiler.hooks.compilation.tap('ModuleCacheWhitespaceCollapse', (compilation: any) => {
      compilation.hooks.processAssets.tap(
        { name: 'ModuleCacheWhitespaceCollapse', stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE },

        (assets: any) => {
          for (const name of Object.keys(assets)) {
            if (!name.endsWith('.js')) continue;
            const asset = assets[name];
            const code = asset.source().toString();
            // Use a ReplaceSource (rather than a fresh RawSource) so the source-map chain
            // is preserved for the downstream inline-source-map devtool step.
            const replaced = new sources.ReplaceSource(asset);
            const re = /(var|let|const) __webpack_module_cache__ = \{\}/g;
            for (let m = re.exec(code); m !== null; m = re.exec(code)) {
              replaced.replace(m.index, m.index + m[0].length - 1, `${m[1]} __webpack_module_cache__={}`);
            }
            assets[name] = replaced;
          }
        }
      );
    });
  }
}
