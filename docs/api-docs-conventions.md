# API Docs Conventions

Conventions for SDK contributors authoring or modifying types that appear in
the [generated API reference](https://typescript.temporal.io). The intent is
that following these conventions yields readable rendered docs without the
author needing to know anything about how the docs pipeline is wired.

The docs pipeline itself, including the custom TypeDoc plugins that enforce
some of these conventions, is described in
[`packages/docs/typedoc-plugins/README.md`](../packages/docs/typedoc-plugins/README.md).

## Readonly inputs: `Readonly<T>`, not `T | Readonly<T>`

If a type parameter, options property, or method argument is meant to be a
read-only view of an array/tuple, write `Readonly<T>` directly. Don't write
`T | Readonly<T>`.

The union is redundant: TypeScript's variance rules make `T` assignable to
`Readonly<T>` at input positions, so callers passing a plain mutable
array/tuple still typecheck. The single-arm form is what readers (and the
docs) should see.

```ts
// Yes
export interface ActivityOptions<Args extends unknown[]> {
  args?: Readonly<Args>;
}

// No — `T |` is dead weight
export interface ActivityOptions<Args extends unknown[]> {
  args?: Args | Readonly<Args>;
}
```

## Hiding things from the API docs

Two JSDoc tags are used to keep symbols out of the rendered API reference.
They overlap mechanically but answer different questions; pick exactly one.

### `@internal` — "this isn't part of the public API"

Use `@internal` when a symbol exists only for cross-package wiring or as an
implementation detail, and is not meant for SDK users. Combined with
`excludeInternal: true` in the docs config, `@internal` reflections are
dropped from the rendered docs.

Examples already in the codebase:

- `encodeXxx` / `decodeXxx` - proto enum converters
- `extractWorkflowType` -
- `compileXxxOptions` and `CompiledXxxOptions` -
- `Replace`, `RequireAtLeastOne` - pure utility types
- `tsToMs()`, `u8()`, `errorCode()`, etc - internal helper functions

Note that it is not necessary to mark symbols as `@internal` if they are never exported as part of public APIs.

### `@ignore` — "this _is_ public API but I don't want it rendered"

Use `@ignore` when a symbol _is_ a component of the public API but shouldn't be called out explicitly in the user-facing API docs.

Common reasons:

- Domain-specific types that are visible to users only as components of other public API types (e.g.`ActivityName`, `ActivityResult`, `WithWorkflowArgs`, `BaseWorkflowOptions`, etc). Those are not intended to be public APIs by themselves and could be changed or removed in the future provided that the public APIs depending on them remain stable.
- Including the symbol in the docs would be noisy and redundant.
- Complex types constructs that only exist to provide stronger type safety checking on public APIs, but that can be collapsed into a simpler, more readable form when rendered in the docs.

It is generally desirable to combine `@ignore` with other TypeDoc tags (either on the item itself or at the use site) to ensure that the symbol to be ignored is never actually required as part of the rendered API docs. For example, the type `ActivityArgs` is only used as part of the `WithActivityArgs` type. If the `WithActivityArgs` type was to be included in rendered docs but the `ActivityArgs` type was not, that would result in a broken link in the docs. To avoid that situation, both the `WithActivityArgs` and `ActivityArgs` types should be marked with `@ignore`, and the `WithActivityArgs` type should be annotated with `@elideTo` so that the `WithActivityArgs` is never needed by itslef as part of the rendered docs.

### Conventions about JSDoc visibility tags

- **Don't use `@hidden`.** It's TypeDoc-specific and not understood by
  TSDoc, api-extractor, or other tools that may read the source. Use
  `@internal` (preferred) or `@ignore`.
- **Don't combine `@internal` and `@ignore` on the same symbol.** They
  overlap mechanically (both hide from docs) but answer different questions.
  Stacking them up is redundant and muddies the meaning of each tag for the
  next author. Pick the one that matches the intent.

## Internal type helpers used in public type signatures: `@elideTo`

Type-algebra helpers like `Replace<Base, …>` and `RequireAtLeastOne<T, …>`
are essential for type safety in the SDK source, but their machinery is
noise in the rendered docs. Without help, a public type defined as
`Replace<ActivityOptions, { args: …; … }>` renders verbatim, exposing the
helper.

The custom TypeDoc plugin `@elideTo` collapses references to such a helper
back to one of its generic parameters in the rendered docs (without
affecting the actual type at all). To use it on a new helper:

1. Mark the helper `@internal` and add an `@elideTo <typeParam>` block tag
   pointing at the type parameter that should "win":

   ```ts
   /**
    * @internal
    * @elideTo Base
    */
   export type Replace<Base, New> = Omit<Base, keyof New> & New;
   ```

2. Re-export the helper from `packages/meta/src/index.ts`.

   This is required because TypeDoc doesn't convert types that aren't
   reachable from the docs entry point ([TypeStrong/typedoc#1420](https://github.com/TypeStrong/typedoc/issues/1420)).
   `packages/meta` is the doc-generation entry point and is not itself a
   published package, so the re-export only reaches the docs pipeline,
   not the public API surface.

The plugin handles everything else: it rewrites references in type trees
(recursively, so chains like `Replace<Replace<…>>` collapse all the way
down) and removes the alias's own page from the rendered docs.

See [`packages/docs/typedoc-plugins/README.md`](../packages/docs/typedoc-plugins/README.md)
for plugin internals.

## Enum-like declaration pattern

The SDK can't use real TypeScript `enum` declarations for proto enums
(loading the proto-compiled enum module into the workflow sandbox isn't
allowed), so we hand-roll the same shape as a pair of declarations:

```ts
export const NexusOperationIdReusePolicy = {
  ALLOW_DUPLICATE: 'ALLOW_DUPLICATE',
  ALLOW_DUPLICATE_FAILED_ONLY: 'ALLOW_DUPLICATE_FAILED_ONLY',
  REJECT_DUPLICATE: 'REJECT_DUPLICATE',
} as const;
export type NexusOperationIdReusePolicy =
  (typeof NexusOperationIdReusePolicy)[keyof typeof NexusOperationIdReusePolicy];
```

The `simplify-enum-likes` TypeDoc plugin auto-detects this pattern and
collapses each pair into a single readable union in the rendered docs
(e.g. `Ƭ NexusOperationIdReusePolicy: "ALLOW_DUPLICATE" | "ALLOW_DUPLICATE_FAILED_ONLY" | "REJECT_DUPLICATE"`),
optionally followed by a "Values" section preserving any per-member JSDoc.

Detection is shape-based — no source-side annotation. For the plugin to
recognize and collapse a pair, the source must satisfy:

- **Same name, same parent.** The const and the type alias must share the
  same name and be declared in the same parent (file/namespace).
- **`as const` literal members.** Every member of the const must be a
  literal value; no computed values, no functions, no nested objects.
- **The type alias body is `(typeof X)[keyof typeof X]`** (any equivalent
  TypeDoc resolves to the same `IndexedAccessType` over a `QueryType`
  shape will work; the boilerplate above is the safe form).

Pairs that don't match are left alone. Notable example: `EncodingType` /
`encodingTypes` (different names) is intentionally not an enum-like pair
and is correctly skipped.

### Filter rules for kept members

The plugin applies two filter rules when building the rendered union, so
authors should know what's safe to write:

1. Members whose value is `undefined` are dropped (typically used for
   protobuf "unspecified" sentinel values that we don't want in the public
   API).
2. Members sharing the same string value are collapsed to one canonical
   (the shortest key, ties by source order). Other members in the group
   are dropped if they are `@deprecated`; non-deprecated peers are kept.

The rule deliberately keeps short-named `@deprecated` canonicals
(e.g. `TERMINATE_IF_RUNNING`) and drops their long-prefixed synonyms
(e.g. `WORKFLOW_ID_REUSE_POLICY_TERMINATE_IF_RUNNING`).

### Member JSDoc

Per-member JSDoc (`/** description */`, `@deprecated`, `@default`) on the
const's properties is preserved in a "Values" section appended to the
alias's docs. `{@link …}` inline tags inside member docs are kept and
continue to link.

One gotcha: a `{@link X.MEMBER}` reference targeting a member that the
filter rules drop becomes dangling (rendered as plain text). Either link
to a member that survives filtering, or rewrite the link.

## Verifying

After adding or changing types in any of the public packages:

```sh
pnpm -F @temporalio/docs run build-docs
```

Spot-check the relevant generated markdown under
`packages/docs/docs/api/**/*.md`. If results look stale or surprising,
clear caches and rebuild:

```sh
rm -rf packages/docs/build packages/docs/.docusaurus packages/docs/docs/api packages/docs/node_modules/.cache
pnpm -F @temporalio/docs run build-docs
```
