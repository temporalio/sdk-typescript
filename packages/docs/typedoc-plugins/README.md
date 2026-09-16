# TypeDoc plugins

Custom TypeDoc plugins that shape the rendered API reference at
<https://typescript.temporal.io>. Loaded by `docusaurus-plugin-typedoc` from
[`packages/docs/docusaurus.config.js`](../docusaurus.config.js):

- [`elide-to.mjs`](./elide-to.mjs) — simplify rendering of complex types in API docs by eliding
  away some utility types, collapsing them back to one of their generic parameters.

- [`simplify-enum-likes.mjs`](./simplify-enum-likes.mjs) — rewrite the const+type components of
  our "const object of strings enum values" idiom into a single union type.

  For example:

  ```typescript
  const NexusOperationIdReusePolicy = {
      ALLOW_DUPLICATE: "ALLOW_DUPLICATE"
      ALLOW_DUPLICATE_FAILED_ONLY: "ALLOW_DUPLICATE_FAILED_ONLY"
      REJECT_DUPLICATE: "REJECT_DUPLICATE"
  } as const;
  type NexusOperationIdReusePolicy = (typeof NexusOperationIdReusePolicy)[keyof typeof NexusOperationIdReusePolicy];
  ```

  will be rendered in docs as if it had been written as:

  ```typescript
  type NexusOperationIdReusePolicy = 'ALLOW_DUPLICATE' | 'ALLOW_DUPLICATE_FAILED_ONLY' | 'REJECT_DUPLICATE';
  ```

Author-facing usage and the source-side rules each plugin enforces are
documented in [`docs/api-docs-conventions.md`](../../../docs/api-docs-conventions.md).

## File format and layout

Plugins are written as `.mjs` with `// @ts-check` and JSDoc imports from
`typedoc`. The `packages/docs/` package has no TypeScript build infra; this
keeps the plugins self-contained and avoids dragging a tsconfig into the
otherwise JS-only docs package. Convert to `.ts` later if/when the docs
package gets its own tsconfig.

The header of each plugin contains a more detailed description of what it
does and the rules it enforces; this file is an overview plus the
TypeDoc-internals lore.

## TypeDoc-internals gotchas (apply to both plugins)

These are the surprises that cost real time during the initial
implementation. Keep them in mind when extending.

### TypeDoc doesn't convert unexported types

[TypeStrong/typedoc#1420](https://github.com/TypeStrong/typedoc/issues/1420)
(wontfix). If a helper isn't reachable from the docs entry point, TypeDoc
emits use-site `ReferenceType`s pointing at it but never creates a
`DeclarationReflection` for the helper itself — so any block tag
annotation on the source declaration is invisible to TypeDoc.

Fix used by `elide-to.mjs`: re-export the helper from
`packages/meta/src/index.ts`. `meta` is the docs entry point; it isn't
itself a published package, so the re-export only reaches the docs
pipeline.

### Modifier tags don't propagate through `export type { X } from 'other'`

TypeDoc 0.25 preserves block tags (e.g. `@elideTo`) when a declaration is
re-exported via `export type { X } from 'other'`, but drops modifier tags
(e.g. `@internal`). The meta-level reflection that the docs entry point
sees therefore _doesn't_ pick up `@internal`, and `excludeInternal: true`
won't drop it.

Fix used by `elide-to.mjs`: do the removal explicitly inside the plugin
(`project.removeReflection(decl)` after substitution). `@internal` is
still kept on the source as a human signal of intent.

### A re-exported declaration converts twice; one copy gets removed early

A re-export _does_ also cause TypeDoc to convert the original (non-meta)
declaration, and that copy keeps `@internal`. So the original alias gets
removed by `excludeInternal` at `EVENT_RESOLVE_BEGIN` — _before_ the
plugin's `EVENT_RESOLVE_END` handler runs. Use-site references in type
trees may still point at this now-removed declaration via an unresolved
`ReflectionSymbolId`.

`project.getSymbolIdFromReflection(decl)` returns `undefined` once a
declaration has been removed, so building a symbol-key lookup at
`EVENT_RESOLVE_END` for the removed declaration is too late.

Fix used by `elide-to.mjs`: capture the stable symbol key at
`EVENT_CREATE_DECLARATION` time (while the declaration is guaranteed
alive) and store it on the registry entry. Build the symbol-key lookup
from those stored keys at `EVENT_RESOLVE_END`, with no dependency on
whether the declaration is still alive at that point.

### TypeScript sometimes flattens generic helpers eagerly

For some sites (`WorkflowExecutionDescription`,
`NexusOperationExecutionDescription`), `Replace<X, { … function-valued
properties … }>` is evaluated eagerly by the TypeScript compiler before
TypeDoc sees the type. Those sites render as the expanded `Base & { … }`
shape rather than as the original `Replace<…>` reference, so the
`@elideTo` plugin has nothing to rewrite. Acceptable in this case: the
expanded form is still readable (no `Replace` noise), just not as
compact as the elided form would be.

### `removeReflection` only cascades through the project's child graph

`project.removeReflection(refl)` removes `refl` and recursively removes
its `children` (in the `parent` / `children` graph) — _and_ any
`ReferenceReflection` instances pointing at it (re-export aliases). It
does NOT cascade through general `ReferenceType` uses inside `.type`
trees.

This matters in two ways:

- For `simplify-enum-likes.mjs`: removing the const _is_ safe even though
  the alias's body originally referenced the const via a `QueryType`,
  because `ReferenceType` uses don't trigger cascading removal.
- For both plugins: any `ReferenceType` in the type tree that pointed at
  a removed declaration must be retargeted by the plugin itself,
  otherwise it will render as a dangling "broken" reference.

### Inline `ReflectionType`s on discarded type arguments leave orphans

In `elide-to.mjs`, when an `@elideTo` reference is substituted, the
discarded type arguments may carry inline `ReflectionType` declarations
that are still registered in `project.reflections`. The plugin walks
those subtrees and calls `removeReflection` on each embedded declaration
to avoid orphans showing up in `project.reflections` after the
substitution.

### Robust target lookup pattern

Both plugins follow the same pattern when matching a `ReferenceType` (or
an `InlineTagDisplayPart.target` in a comment) back to a declaration we
care about:

1. Try the resolved `reflection.id`.
2. Fall back to the symbol's stable key, captured at
   `EVENT_CREATE_DECLARATION` time and stored on the registry entry.
3. As a last resort, the internal `_target` slot.

This survives reflections being removed mid-pipeline (e.g. by
`excludeInternal`). Keep this pattern when adding new plugins.

## `simplify-enum-likes.mjs` notes

- **Detection is shape-based; no annotation.** See `isEnumLikeTypeShape` /
  `isEnumLikeConstShape` in the plugin source. Anything that doesn't
  match is silently skipped.
- **Filter rule.** The const's members are filtered before becoming the
  union: drop `undefined`-valued members; for groups of synonym members
  sharing one value, the canonical is the shortest key (ties by source
  order) and any other `@deprecated` members in the group are dropped.
  See the plugin header for rationale.
- **Member info preservation strategy.** "Markdown injection": rewrite the
  alias's `.type` to a `LiteralType` union (clean header), copy the
  const's comment onto the alias if the alias is bare, append a
  `**Values:**` markdown section as `CommentDisplayPart`s. Inline
  `{@link …}` tags are carried over via `Comment.cloneDisplayParts`,
  preserving link semantics. Newlines inside text parts are collapsed so
  each value row stays on a single markdown list-item line.

  ```sh
  rm -rf packages/docs/build packages/docs/.docusaurus packages/docs/docs/api packages/docs/node_modules/.cache
  pnpm -F @temporalio/docs run build-docs
  ```

## References

- TypeDoc plugin docs and source — <https://typedoc.org/api/>
- Recipe-style discussions on the TypeStrong/typedoc tracker:
  - [#1474](https://github.com/TypeStrong/typedoc/issues/1474)
  - [#1513](https://github.com/TypeStrong/typedoc/issues/1513)
  - [#2273](https://github.com/TypeStrong/typedoc/issues/2273)
- The wontfix that drove the meta re-export trick:
  [#1420](https://github.com/TypeStrong/typedoc/issues/1420)
