# ESM-only publication feasibility

## Decision

Migrating the SDK's published JavaScript packages to **ESM only** is feasible for
Node.js 22+ and Bun 1.4.  It should be treated as a breaking, major-version
migration and be done in two deliberately separate pieces:

1. Publish the SDK packages as ESM (`"type": "module"`, ESM `lib/*.js`, and
   explicit `exports` maps).
2. Keep the generated Workflow bundle as webpack's current **classic script**
   format for now. Webpack can consume ESM package/source input while emitting
   that script; changing the generated artifact to native ESM is a distinct VM
   runtime redesign, not a prerequisite for ESM-only packages.

This boundary is important. “ESM-only SDK packages” means there is no CJS entry
point for consumers. It does **not** mean that every implementation detail,
especially a code string executed in a `vm.Context`, must be an ESM module.

## What the repository currently does

The repository is currently CJS-oriented:

| Area | Current state | ESM migration impact |
| --- | --- | --- |
| TypeScript | `tsconfig.base.json` uses `module: "commonjs"` and `moduleResolution: "node"`. All 31 workspace/contrib package configs inherit it. | Switch package compilation to Node-aware ESM (`nodenext`); `node` resolution would allow paths that Node ESM rejects. |
| Published package metadata | 27 package manifests declare `main`; most have no `exports`. Only `@temporalio/create` declares `type: module`. | Add `type: module` and an explicit public export map for every published package. |
| Source specifiers | About 1,700 relative static imports/re-exports omit `.js`; about 366 production imports deep-import `@temporalio/*/lib/*`. | Node ESM requires the emitted `.js` extension for relative and package-relative paths. Codemod and validate all emitted specifiers. |
| CJS implementation sites | `@temporalio/core-bridge` bootstrap and its native-addon loader use `require`/`module.exports`; generated proto files use CJS; a small number of runtime and Workflow shim paths use `require`. | Convert ordinary loading to imports; retain `createRequire` only where a native addon or intentionally CJS-only dependency requires it. Regenerate/replace the proto wrapper. |
| Workflow execution | `WorkflowCodeBundler` creates a `.cjs` virtual entrypoint, emits `library: '__TEMPORAL__'`, and the Worker runs the resulting source with `new vm.Script(...)`. | Do not enable webpack ESM output in the first package migration. |

The only existing `type: module` package is `@temporalio/create`, but it still
inherits the CJS compiler configuration. That combination must be corrected as
part of the common migration rather than treated as proof that the package is
already ESM-correct.

## Runtime baseline: Node 22+ and Bun 1.4

### Node.js 22+

Node determines the format of `.js` using the nearest `package.json` `type`;
`"type": "module"` makes `.js` ESM, while `.cjs` remains CJS. Package authors
should use an explicit marker instead of relying on Node's syntax detection.
[Node's package documentation](https://nodejs.org/download/release/v22.21.0/docs/api/packages.html#type)
and [ESM documentation](https://nodejs.org/download/release/v22.21.0/docs/api/esm.html)
cover these rules.

For this repository's minimum Node version, the practical rules are:

- ESM has no ambient `require`, `module`, `exports`, `__filename`, or
  `__dirname`. Node 22.16 made `import.meta.dirname` and
  `import.meta.filename` stable; use them (or `new URL(..., import.meta.url)`)
  for file-relative resources.
- A relative or absolute ESM specifier must name the file, for example
  `./worker.js`; extensionless paths and directory-index lookup are not
  performed. This applies to `@temporalio/common/lib/time` too when it is a
  package-relative path.
- Importing JSON needs `with { type: 'json' }` in Node 22.12+; avoid
  accidentally replacing synchronous `require('./x.json')` with a bare JSON
  import.
- ESM can import CJS, but named CJS exports are detected heuristically. Prefer
  a default import and unwrap it where the dependency is CJS, then exercise the
  actual dependency version in tests.
- Node 22 supports synchronous `require(esm)` only for graphs without
  top-level `await`. That is useful as a temporary consumer transition aid, but
  it is not a compatibility promise to make: users on Node versions older than
  the new baseline, other loaders, and tools may still fail. Do not add a
  `require` condition or a CJS build merely to preserve it.
- Native `.node` addons are not normally loaded by static ESM import. The
  core-bridge package should load its prebuilt addon through
  `createRequire(import.meta.url)` (or `process.dlopen`) while exporting the
  resulting API from ESM. This is an implementation bridge, not a CJS package
  entry point. See Node's [ESM differences from CJS](https://nodejs.org/download/release/v22.21.0/docs/api/esm.html#differences-between-es-modules-and-commonjs).

### Bun 1.4

Bun's runtime recommends ESM and runs ESM and CJS together, but it is more
permissive than Node: it accepts extensionless local imports, permits `require`
inside ESM, and can `require()` an ESM namespace (except a graph that uses
top-level await). Its resolver also tries TypeScript source when a local
specifier ends in `.js`.

Those conveniences make local Bun testing a **non-sufficient** ESM test. Use
Node 22 as the conformance gate and run Bun 1.4 as a supported-runtime gate.
The SDK should nevertheless emit Node-valid `.js` specifiers everywhere.
[Bun's module-resolution documentation](https://bun.com/docs/runtime/module-resolution)
describes the interop and resolution differences; its
[bundler documentation](https://bun.com/docs/bundler) identifies ESM as Bun's
default output format.

No Bun-specific `bun` export condition is needed for this migration. A single
standards-oriented ESM artifact, selected by `import`/`default`, is the least
surprising surface for Node and Bun. Add a Bun condition only for a real,
tested Bun-specific implementation.

## Package design

Use one ESM artifact per package rather than dual publishing. A representative
manifest shape is:

```json
{
  "type": "module",
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "import": "./lib/index.js",
      "default": "./lib/index.js"
    },
    "./workflow": {
      "types": "./lib/workflow.d.ts",
      "import": "./lib/workflow.js",
      "default": "./lib/workflow.js"
    }
  },
  "types": "./lib/index.d.ts"
}
```

`main` can be removed once every intended entry point is in `exports`. Keep a
top-level `types` field even when each export has a `types` condition, because
tooling and the npm UI still use it.

The initial export map needs an explicit decision on the existing deep `lib/`
surface. The SDK itself has 366 such production imports, and consumers may have
more. Introducing `exports` without listing those paths makes every unlisted
deep import fail immediately.

Two workable approaches are:

1. **Compatibility-first (recommended for the ESM release):** export every
   currently shipped, supported deep path that the SDK itself uses, with ESM
   extensions in the targets. For example, a pattern such as
   `"./lib/*": { "types": "./lib/*.d.ts", "import": "./lib/*.js" }` can
   preserve the existing shape *after* callers change
   `@temporalio/common/lib/time` to `@temporalio/common/lib/time.js`.
   Explicitly document these as compatibility/internal exports and deprecate
   them.
2. **API-first:** replace all internal and supported consumer paths with named
   public subpaths (for example `@temporalio/common/time`) and export only
   those. This produces a better long-term API but enlarges the major-version
   migration and requires a deliberate public-API review.

Do not publish a broad, undocumented `./*` export simply to get the build
green. It freezes accidental files as public API. Also do not point `exports`
at `src`: package execution must use the compiled `lib` ESM, including in the
packed tarball.

`exports` condition order matters: Node and Bun choose the first matching
condition. Include `types` first for TypeScript, then `import` and `default`;
omit `require` for an ESM-only contract. TypeScript's Node-aware resolution
models these conditional exports and selects `import` versus `require` based on
the emitted form. See the [TypeScript ESM/Node reference](https://www.typescriptlang.org/docs/handbook/esm-node.html).

## Compiler and source conversion

Adopt the Node runtime model, not bundler resolution, for emitted packages:

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext"
  }
}
```

Every publishing package must be under a `package.json` with
`"type": "module"`; otherwise `nodenext` can still emit CJS for plain `.ts`
files. Use `.mts` only where a file must be irrevocably ESM independent of its
package boundary. Reserve `.cts`/`.cjs` for a truly unavoidable local CJS
island, not as a general transition mechanism.

The high-volume mechanical changes are:

- Rewrite relative source imports/re-exports from `./x` to `./x.js` (and
  `../x` to `../x.js`). TypeScript resolves the `.js` source specifier to the
  matching `.ts` input and preserves it in both JavaScript and declarations.
- Rewrite SDK package-relative deep imports to their emitted `.js` path, or to
  a new named exported subpath. Do this before locking `exports` down.
- Replace `__dirname`/`__filename` in emitted modules with
  `import.meta.dirname`/`import.meta.filename` or URL-based path operations.
  Build scripts that remain run by `tsx` need their own verification; do not
  assume a source runner follows exactly the production Node loader.
- Replace ordinary optional/dynamic CJS loads with static ESM imports where
  possible. For genuinely conditional loading, use `await import()` and update
  the surrounding API/control flow to be async. Use `createRequire` narrowly
  for native addons or a dependency that demonstrably cannot be imported.
- Convert `packages/core-bridge/index.js` and `common.js` to ESM while retaining
  `createRequire` for the `.node` binary. The generated protobuf
  `json-module.js`, `root.js`, and `index.js` also need an ESM generation or
  wrapper strategy; the proto generator currently requests protobufjs
  `--wrap commonjs`.

Do not select TypeScript's `bundler` resolution for package compilation simply
because webpack accepts extensionless imports. It intentionally permits paths
that native Node ESM rejects, and declarations published with those paths can
break consumers using `nodenext`.

## Workflow webpack bundles: retain classic output

The normal Workflow bundle has a different loader contract than an npm package:

```text
Workflow/user ESM and SDK ESM
           |
           v
webpack resolves and bundles all code
           |
           v
classic script assigning global __TEMPORAL__
           |
           v
new vm.Script(code) -> vm.Context -> __TEMPORAL__.api
```

Webpack already parses ESM and CJS inputs. Therefore ESM conversion of
`@temporalio/workflow` and user workflow dependencies is compatible with the
existing bundler, provided webpack resolves the package export map and every
deep internal path is exported.

The emitted artifact should remain a script because the current implementation
depends on all of the following:

- the virtual generated entrypoint is deliberately `.cjs` and uses webpack
  eager `require()` calls to synchronously load workflows, interceptors, and
  preloads;
- the entrypoint assigns `exports.api`, and `output.library: '__TEMPORAL__'`
  exposes a synchronous global consumed by the Worker;
- `vm.Script`/`script.runInContext()` evaluates a script, rather than using an
  ESM module linker/evaluator;
- `worker-interface.ts` has deliberate webpack-only `require()` calls for
  alias-selected payload and failure converters;
- the module-cache isolation plugin patches webpack's generated
  `__webpack_require__` runtime and redirects its cache to
  `globalThis.__webpack_module_cache__`. Its assertions and reusable-context
  behavior are tied to that runtime shape;
- `commonjsMagicComments` is enabled specifically for a CJS optional `fs`
  probe in `protobufjs`.

Webpack can emit an actual ESM library with `output.module: true` and
`library.type: 'module'`, but that output ends in `export` statements and must
be imported through an ESM module loader. It cannot be evaluated as the current
`vm.Script` global library. The webpack documentation describes this
requirement in its [output module section](https://webpack.js.org/configuration/output/#outputmodule)
and [module library output](https://webpack.js.org/configuration/output/#type-module).

Attempting that conversion as part of the package migration risks breaking:

- synchronous bundle initialization and the `__TEMPORAL__` contract;
- custom converter aliases and eager interceptor/preload ordering;
- the reusable VM's per-workflow module-cache isolation;
- source-map/error behavior and the test fixtures that include pre-bundled
  webpack dependencies.

If native ESM Workflow artifacts become a separate goal, first prototype a
`vm.SourceTextModule`-based loader (and verify Bun's equivalent VM behavior),
design linking for all webpack chunks/dynamic imports, replace the global
library API with explicit module namespace handling, and redesign the module
cache isolation hook. It should have an independent proposal and compatibility
test matrix.

## Compatibility hazards

- **CJS consumers.** `require('@temporalio/worker')` is no longer a supported
  consumption API. Node 22 may load a synchronous ESM graph through `require`,
  but consumers must migrate to `import`; top-level await would make that
  incidental route fail.
- **Exports are an API firewall.** Any missing root/subpath or a missing
  extension becomes `ERR_PACKAGE_PATH_NOT_EXPORTED` or
  `ERR_MODULE_NOT_FOUND`. Test package tarballs, not just workspace symlinks.
- **CJS dependency interop.** Default-versus-named export differences and
  mutation/liveness semantics vary. Audit runtime imports from CJS dependencies
  such as protobuf-related tooling rather than relying solely on type-checking.
- **Cycles and initialization order.** ESM has live bindings and evaluates
  cycles differently from CJS. Particularly audit global initialization,
  side-effect imports, `instanceof`/error constructors, and Workflow
  interceptor registration.
- **Top-level await.** It is valid ESM but changes the load graph into an async
  boundary. Avoid it in foundational packages unless initialization is designed
  to be async; it also removes Node's synchronous `require(esm)` fallback.
- **Tests and tools.** AVA configuration, generated test launchers, `tsx`,
  Node worker threads, and docs tooling contain CJS configuration files or
  `__dirname` use. These may remain `.cjs` where their host requires it; the
  ESM-only promise applies to published SDK entry points, not every development
  configuration file.
- **Lambda prebundles.** Existing examples load a Workflow bundle with
  `require('./workflow-bundle.js')`. The bundle remains a script/string artifact
  in the recommended approach, but examples and generated application code
  should be updated to ESM-safe loading (`createRequire` or file read) if the
  surrounding Lambda application becomes ESM.
- **Bun permissiveness.** Passing `bun` does not prove a published package is
  Node ESM-safe, because Bun permits the extensionless and `require` patterns
  that Node ESM rejects.

## Suggested rollout

1. **Define the contract.** Announce Node `>=22` and Bun `>=1.4`, ESM-only
   consumption, no `require` export condition, and the intended public
   root/subpath API. Decide whether the temporary `./lib/*` compatibility
   exports are acceptable.
2. **Create an automated baseline.** Add a check over packed package contents
   that confirms `type: module`, ESM output, no accidental CJS files in public
   entrypoints, valid export targets, and no extensionless relative specifiers
   in emitted JS or `.d.ts` files.
3. **Convert package metadata and TypeScript together.** Change the shared
   compiler baseline to `nodenext`, add `type: module` and `exports` to every
   published package, then make the import-specifier codemod. Do not land only
   one half: `type: module` plus CJS output fails at runtime.
4. **Address CJS islands.** Convert core-bridge and proto generation, add the
   minimal native-addon `createRequire` bridge, and preserve dev-only CJS config
   explicitly as `.cjs` where required.
5. **Validate the Workflow boundary.** Keep its generated entrypoint and output
   script configuration unchanged initially. Run the existing workflow bundle,
   reusable-VM/module-cache, custom converter, interceptor, and prebundled
   dependency tests against ESM-built packages.
6. **Publish a prerelease.** Install each packed tarball into clean Node 22 and
   Bun 1.4 fixtures. Exercise public root and documented subpaths, ESM imports,
   core-bridge native loading, Client/Worker, Workflow bundling, Lambda
   prebundle consumption, and a representative contributed integration.
7. **Release as a major version.** Provide a migration guide with before/after
   imports, `__dirname` replacements, CJS-consumer guidance, deep-import
   changes, and explicit non-goals for native-ESM Workflow bundles.

## Acceptance matrix

| Scenario | Node 22+ | Bun 1.4 | Why it matters |
| --- | --- | --- | --- |
| Import each root package and documented subpath from a clean packed install | Required | Required | Verifies metadata, exports, declarations, and actual package contents. |
| Typecheck a consumer using `module`/`moduleResolution: nodenext` | Required | Recommended | Catches declaration specifiers that bundler resolution would hide. |
| Run Worker + normal Workflow bundle | Required | Required | Confirms webpack consumes ESM inputs while the output remains a script. |
| Reusable VM and pre-bundled-webpack dependency tests | Required | Required | Protects the patched webpack module cache and isolation behavior. |
| Custom payload/failure converter and interceptor bundle tests | Required | Required | Protects webpack aliases and eager loading. |
| Core bridge native addon load | Required | Required where supported | Validates the intentional `createRequire` bridge. |
| CJS `require()` consumer | Documented unsupported | Documented unsupported | It may happen to work in modern Node/Bun, but is not a contractual test. |

## Recommendation

Proceed with an ESM-only major release, with Node 22 as the strict compatibility
oracle and Bun 1.4 as a separately tested runtime. The source conversion and
export-map audit are meaningful work but are mechanical and testable. Do **not**
combine it with emitting native-ESM Workflow bundles: retaining webpack's
classic `__TEMPORAL__` script output isolates risk, preserves VM semantics, and
still delivers ESM directly to all normal SDK consumers.
