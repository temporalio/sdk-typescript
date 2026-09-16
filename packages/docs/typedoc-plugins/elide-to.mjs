// @ts-check
/**
 * TypeDoc plugin: `@elideTo`.
 *
 * Lets a type alias or interface tell TypeDoc to render every reference to it
 * as one of its own type arguments instead of as the resolved computed shape.
 * This keeps API docs readable when a type alias performs type algebra (e.g.
 * `RequireAtLeastOne`, `Replace`) whose machinery is not relevant to the
 * reader of the docs.
 *
 * Usage:
 *
 *     /**
 *      * @elideTo T
 *      *\/
 *     export type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = ...;
 *
 *     /** @elideTo Base *\/
 *     export type Replace<Base, New> = Omit<Base, keyof New> & New;
 *
 * Given those annotations, TypeDoc will render:
 *
 *     RequireAtLeastOne<Foo, 'a' | 'b'>          -> Foo
 *     Replace<ActivityOptions, { x: number }>     -> ActivityOptions
 *     Promise<Replace<Foo, { y: string }>>        -> Promise<Foo>
 *
 * Substitutions are applied recursively, so chains like
 * `Replace<RequireAtLeastOne<X, 'a'>, { y: string }>` collapse all the way
 * down to `X`.
 *
 * Compatibility: this plugin works correctly even when the elide-tagged
 * alias is also marked `@internal` (and `excludeInternal: true` is on). The
 * elide registry is built at `EVENT_CREATE_DECLARATION` time, before
 * TypeDoc's CommentPlugin removes `@internal` reflections, and substitution
 * at `EVENT_RESOLVE_END` falls back to symbol-id lookup so it still works
 * for references whose target has since been removed.
 */

import td from 'typedoc';

/** @type {`@${string}`} */
const TAG = '@elideTo';

/**
 * @typedef {Object} ElideInfo
 * @property {td.DeclarationReflection} declaration  The annotated alias declaration.
 * @property {string} paramName                      Name of the type parameter to substitute in.
 * @property {string} [symbolKey]                    Stable symbol key captured at register time,
 *                                                   so we can still match references after the
 *                                                   declaration is removed (e.g. by `@internal`).
 */

/**
 * @param {td.Application} app
 */
export function load(app) {
  const existing = app.options.getValue('blockTags');
  if (!existing.includes(TAG)) {
    app.options.setValue('blockTags', [...existing, TAG]);
  }

  /** @type {Map<number, ElideInfo>} */
  const elideByReflId = new Map();

  app.converter.on(td.Converter.EVENT_CREATE_DECLARATION, (context, refl) => {
    const tag = refl.comment?.getTag(TAG);
    if (!tag) return;
    const paramName = td.Comment.combineDisplayParts(tag.content).trim();
    if (!paramName) {
      app.logger.warn(`${TAG} on ${refl.getFullName()} has no type parameter name.`);
      return;
    }
    // Capture the symbol key NOW, while the declaration is guaranteed to be
    // alive in the project. If the declaration is later removed (e.g. because
    // it's `@internal` and `excludeInternal: true` is set),
    // `getSymbolIdFromReflection` would return undefined and we'd lose the
    // ability to match use-site references by symbol id. Use-site references
    // typically carry an unresolved `ReflectionSymbolId` whose stable key
    // matches this one, so storing it here is what enables elision to
    // continue working post-removal.
    const symbolId = context.project.getSymbolIdFromReflection(refl);
    elideByReflId.set(refl.id, {
      declaration: refl,
      paramName,
      symbolKey: symbolId?.getStableKey(),
    });
  });

  app.converter.on(td.Converter.EVENT_RESOLVE_END, (context) => {
    if (elideByReflId.size === 0) return;

    /** @type {Map<string, ElideInfo>} */
    const elideBySymbolKey = new Map();
    for (const info of elideByReflId.values()) {
      if (info.symbolKey) elideBySymbolKey.set(info.symbolKey, info);
    }

    const project = context.project;
    for (const refl of Object.values(project.reflections)) {
      rewriteReflection(refl, elideByReflId, elideBySymbolKey, project, app);
    }

    // Now that every reference to an elide-tagged alias has been rewritten,
    // remove the alias declarations themselves from the project. Without
    // this, the aliases would still get rendered (e.g. on the meta-level
    // index page) showing their full computed expansion — exactly what the
    // elision was meant to hide.
    //
    // This is a no-op for declarations that have already been removed
    // (e.g. by `@internal` + `excludeInternal: true`), but it's needed for
    // declarations reached via TypeDoc's `export type { X } from 'other'`
    // path: that path propagates the original declaration's block tags but
    // drops its modifier tags, so `@internal` on the source declaration
    // doesn't reach the re-exported reflection at the meta level.
    for (const info of elideByReflId.values()) {
      if (project.reflections[info.declaration.id] === info.declaration) {
        project.removeReflection(info.declaration);
      }
    }
  });
}

/**
 * @param {td.Reflection} refl
 * @param {Map<number, ElideInfo>} byId
 * @param {Map<string, ElideInfo>} bySym
 * @param {td.ProjectReflection} project
 * @param {td.Application} app
 */
function rewriteReflection(refl, byId, bySym, project, app) {
  if (refl instanceof td.DeclarationReflection) {
    refl.type = maybeRewrite(refl.type, byId, bySym, project, app);
    rewriteSomeTypeArray(refl.extendedTypes, byId, bySym, project, app);
    rewriteSomeTypeArray(refl.implementedTypes, byId, bySym, project, app);
    refl.overwrites = maybeRewriteReferenceField(refl.overwrites, byId, bySym, project, app);
    refl.inheritedFrom = maybeRewriteReferenceField(refl.inheritedFrom, byId, bySym, project, app);
    refl.implementationOf = maybeRewriteReferenceField(refl.implementationOf, byId, bySym, project, app);
  } else if (refl instanceof td.SignatureReflection) {
    refl.type = maybeRewrite(refl.type, byId, bySym, project, app);
    refl.overwrites = maybeRewriteReferenceField(refl.overwrites, byId, bySym, project, app);
    refl.inheritedFrom = maybeRewriteReferenceField(refl.inheritedFrom, byId, bySym, project, app);
    refl.implementationOf = maybeRewriteReferenceField(refl.implementationOf, byId, bySym, project, app);
  } else if (refl instanceof td.ParameterReflection) {
    refl.type = maybeRewrite(refl.type, byId, bySym, project, app);
  } else if (refl instanceof td.TypeParameterReflection) {
    refl.type = maybeRewrite(refl.type, byId, bySym, project, app);
    refl.default = maybeRewrite(refl.default, byId, bySym, project, app);
  }
}

/**
 * `overwrites`/`inheritedFrom`/`implementationOf` must remain a `ReferenceType`
 * even after rewriting. If elision would replace it with something else, we
 * leave the original in place (those slots are metadata pointers, not displayed
 * type signatures, so eliding them doesn't help readers).
 *
 * @param {td.ReferenceType | undefined} r
 * @param {Map<number, ElideInfo>} byId
 * @param {Map<string, ElideInfo>} bySym
 * @param {td.ProjectReflection} project
 * @param {td.Application} app
 */
function maybeRewriteReferenceField(r, byId, bySym, project, app) {
  if (!r) return r;
  const rewritten = rewriteType(r, byId, bySym, project, app);
  return rewritten instanceof td.ReferenceType ? rewritten : r;
}

/**
 * @param {td.SomeType[] | undefined} arr
 * @param {Map<number, ElideInfo>} byId
 * @param {Map<string, ElideInfo>} bySym
 * @param {td.ProjectReflection} project
 * @param {td.Application} app
 */
function rewriteSomeTypeArray(arr, byId, bySym, project, app) {
  if (!arr) return;
  for (let i = 0; i < arr.length; i++) {
    arr[i] = rewriteType(arr[i], byId, bySym, project, app);
  }
}

/**
 * @param {td.SomeType | undefined} t
 * @param {Map<number, ElideInfo>} byId
 * @param {Map<string, ElideInfo>} bySym
 * @param {td.ProjectReflection} project
 * @param {td.Application} app
 */
function maybeRewrite(t, byId, bySym, project, app) {
  return t ? rewriteType(t, byId, bySym, project, app) : t;
}

/**
 * Walk a type tree, eliding any `ReferenceType` whose target is tagged with
 * `@elideTo`, and recursing into child types. Mutates composite types in
 * place; returns a (possibly different) `SomeType` for the root.
 *
 * @param {td.SomeType} t
 * @param {Map<number, ElideInfo>} byId
 * @param {Map<string, ElideInfo>} bySym
 * @param {td.ProjectReflection} project
 * @param {td.Application} app
 * @returns {td.SomeType}
 */
function rewriteType(t, byId, bySym, project, app) {
  if (t instanceof td.ReferenceType) {
    const info = lookupElideInfo(t, byId, bySym);
    if (info) {
      const substitution = tryElide(t, info, project, app);
      if (substitution) {
        return rewriteType(substitution, byId, bySym, project, app);
      }
    }
    if (t.typeArguments) {
      rewriteSomeTypeArray(t.typeArguments, byId, bySym, project, app);
    }
    return t;
  }

  switch (t.type) {
    case 'array':
      t.elementType = rewriteType(t.elementType, byId, bySym, project, app);
      return t;
    case 'conditional':
      t.checkType = rewriteType(t.checkType, byId, bySym, project, app);
      t.extendsType = rewriteType(t.extendsType, byId, bySym, project, app);
      t.trueType = rewriteType(t.trueType, byId, bySym, project, app);
      t.falseType = rewriteType(t.falseType, byId, bySym, project, app);
      return t;
    case 'indexedAccess':
      t.objectType = rewriteType(t.objectType, byId, bySym, project, app);
      t.indexType = rewriteType(t.indexType, byId, bySym, project, app);
      return t;
    case 'inferred':
      if (t.constraint) t.constraint = rewriteType(t.constraint, byId, bySym, project, app);
      return t;
    case 'intersection':
      t.types = t.types.map((x) => rewriteType(x, byId, bySym, project, app));
      return t;
    case 'mapped':
      t.parameterType = rewriteType(t.parameterType, byId, bySym, project, app);
      t.templateType = rewriteType(t.templateType, byId, bySym, project, app);
      if (t.nameType) t.nameType = rewriteType(t.nameType, byId, bySym, project, app);
      return t;
    case 'namedTupleMember':
      t.element = rewriteType(t.element, byId, bySym, project, app);
      return t;
    case 'optional':
      t.elementType = rewriteType(t.elementType, byId, bySym, project, app);
      return t;
    case 'predicate':
      if (t.targetType) t.targetType = rewriteType(t.targetType, byId, bySym, project, app);
      return t;
    case 'query': {
      const r = rewriteType(t.queryType, byId, bySym, project, app);
      if (r instanceof td.ReferenceType) t.queryType = r;
      return t;
    }
    case 'reflection':
      // The contained DeclarationReflection has its own entry in
      // project.reflections and will be visited by the outer loop.
      return t;
    case 'rest':
      t.elementType = rewriteType(t.elementType, byId, bySym, project, app);
      return t;
    case 'templateLiteral':
      t.tail = t.tail.map(
        ([sub, str]) => /** @type {[td.SomeType, string]} */ ([rewriteType(sub, byId, bySym, project, app), str])
      );
      return t;
    case 'tuple':
      t.elements = t.elements.map((x) => rewriteType(x, byId, bySym, project, app));
      return t;
    case 'typeOperator':
      t.target = rewriteType(t.target, byId, bySym, project, app);
      return t;
    case 'union':
      t.types = t.types.map((x) => rewriteType(x, byId, bySym, project, app));
      return t;
    default:
      return t;
  }
}

/**
 * Look up elide info for a reference. Resolves via the (possibly cached)
 * resolved reflection id when available, and falls back to the symbol id —
 * which still works after the target reflection has been removed by
 * `excludeInternal`.
 *
 * @param {td.ReferenceType} ref
 * @param {Map<number, ElideInfo>} byId
 * @param {Map<string, ElideInfo>} bySym
 */
function lookupElideInfo(ref, byId, bySym) {
  const resolved = ref.reflection;
  if (resolved && byId.has(resolved.id)) return byId.get(resolved.id);
  const symId = ref.symbolId;
  if (symId) {
    const hit = bySym.get(symId.getStableKey());
    if (hit) return hit;
  }
  // `_target` is the internal slot ReferenceType uses to track its resolution
  // state. We read it directly as a last resort because once a reference has
  // been resolved to a numeric id (`_target` becomes a number) and the target
  // is later removed from the project, both the `reflection` and `symbolId`
  // getters return undefined — losing the link we need. Reading `_target`
  // recovers it. This is an intentional dependency on a TypeDoc 0.25 impl
  // detail; if the field is ever renamed, the plugin fails open (no elision).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const target = /** @type {any} */ (ref)._target;
  if (typeof target === 'number' && byId.has(target)) return byId.get(target);
  return undefined;
}

/**
 * Perform the actual substitution for one use site. Returns the elided type,
 * or undefined if the elision is not possible (missing type argument, etc.).
 *
 * @param {td.ReferenceType} ref
 * @param {ElideInfo} info
 * @param {td.ProjectReflection} project
 * @param {td.Application} app
 * @returns {td.SomeType | undefined}
 */
function tryElide(ref, info, project, app) {
  const params = info.declaration.typeParameters;
  if (!params || params.length === 0) {
    app.logger.warn(`${TAG} on ${info.declaration.getFullName()} but the declaration has no type parameters.`);
    return undefined;
  }
  const idx = params.findIndex((p) => p.name === info.paramName);
  if (idx === -1) {
    app.logger.warn(
      `${TAG} ${info.paramName} on ${info.declaration.getFullName()}: no such type parameter ` +
        `(available: ${params.map((p) => p.name).join(', ')}).`
    );
    return undefined;
  }
  const kept = ref.typeArguments?.[idx];
  if (!kept) {
    app.logger.warn(
      `${TAG} ${info.paramName} on ${info.declaration.getFullName()}: reference at use site ` +
        `did not supply a type argument for that parameter.`
    );
    return undefined;
  }
  // Discard sibling type arguments. They may carry inline TypeLiteral
  // ReflectionTypes whose DeclarationReflections were registered in
  // project.reflections during conversion; if we drop them silently they
  // become unreachable but still occupy ids, which has historically tripped
  // up TypeDoc's JSON round-trip. Walk them and clean up explicitly.
  if (ref.typeArguments) {
    for (let i = 0; i < ref.typeArguments.length; i++) {
      if (i === idx) continue;
      removeOrphanedReflections(ref.typeArguments[i], project);
    }
  }
  return kept;
}

/**
 * Remove any DeclarationReflections embedded inside a discarded type subtree.
 *
 * @param {td.SomeType} t
 * @param {td.ProjectReflection} project
 */
function removeOrphanedReflections(t, project) {
  t.visit(
    td.makeRecursiveVisitor({
      reflection(rt) {
        project.removeReflection(rt.declaration);
      },
    })
  );
}
