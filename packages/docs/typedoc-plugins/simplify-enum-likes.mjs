// @ts-check
/**
 * TypeDoc plugin: collapse "enum-like" declaration pairs into a single
 * enum-like entry.
 *
 * The Temporal SDK can't use real TypeScript `enum` declarations for proto
 * enums (loading the proto-compiled enum module into the workflow sandbox
 * is not allowed), so we hand-roll the same shape as a pair of declarations:
 *
 *     export const NexusOperationIdReusePolicy = {
 *       ALLOW_DUPLICATE: 'ALLOW_DUPLICATE',
 *       ...
 *     } as const;
 *     export type NexusOperationIdReusePolicy =
 *       (typeof NexusOperationIdReusePolicy)[keyof typeof NexusOperationIdReusePolicy];
 *
 * Both names work great in IDEs, at compile time and at runtime, but in the
 * generated API docs they pollute the page with two sibling entries:
 *
 *   - The TYPE alias renders as `Ƭ X: typeof X[keyof typeof X]` — pure
 *     type-algebra noise.
 *   - The CONST renders as `• Const X: Object` with a "Type declaration"
 *     table of members. Information-bearing, but visually awful, and the
 *     reader sees two same-named entries with `-1` / `-2` anchor suffixes.
 *
 * What this plugin does, for every detected pair:
 *
 *   1. Replace the TYPE alias's body with a literal union of the unique
 *      string values from the CONST, after applying a filter rule (below).
 *      The page header becomes `Ƭ X: "A" | "B" | "C"`.
 *   2. Copy the CONST's JSDoc comment onto the alias if the alias is bare.
 *   3. Append a markdown "Values" section to the alias's comment, listing
 *      members that have meaningful per-member JSDoc (descriptions,
 *      `@deprecated`, `@default`) — preserves info the union itself can't.
 *      Plain enums with no per-member docs render as just the union.
 *   4. Retarget every {@link X} and {@link X.MEMBER} reference (and every
 *      ReferenceType in the project's type trees) that pointed at the CONST
 *      or one of its members so that it points at the surviving alias.
 *   5. Remove the CONST declaration. TypeDoc's `removeReflection` recursively
 *      removes its inline ReflectionType declaration and child properties.
 *
 * Detection is automatic and shape-based (no annotation needed). The exact
 * shape required is documented at {@link isEnumLikeTypeShape} /
 * {@link isEnumLikeConstShape}; anything that doesn't match is left alone.
 *
 * Filter rule for which CONST members survive into the union and the
 * (optional) values table:
 *
 *   1. Drop any member whose value is `undefined`.
 *   2. Group remaining members by string value. Within each group, the
 *      "canonical" member is the one with the shortest key (ties broken by
 *      source order). Drop every other member in the group that is
 *      `@deprecated`; keep non-deprecated peers as-is.
 *
 * The rule deliberately keeps short-named `@deprecated` canonicals
 * (e.g. `TERMINATE_IF_RUNNING`) while dropping their long-prefixed
 * synonyms (e.g. `WORKFLOW_ID_REUSE_POLICY_TERMINATE_IF_RUNNING`).
 */

import td from 'typedoc';

/**
 * @param {td.Application} app
 */
export function load(app) {
  app.converter.on(td.Converter.EVENT_RESOLVE_END, (context) => {
    const project = context.project;
    const pairs = findEnumLikePairs(project);
    for (const pair of pairs) {
      mergePair(pair, project, app);
    }
  });
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * @param {td.ProjectReflection} project
 * @returns {Array<{ constDecl: td.DeclarationReflection, typeAlias: td.DeclarationReflection }>}
 */
function findEnumLikePairs(project) {
  /** @type {Array<{ constDecl: td.DeclarationReflection, typeAlias: td.DeclarationReflection }>} */
  const pairs = [];

  for (const refl of Object.values(project.reflections)) {
    if (!(refl instanceof td.DeclarationReflection)) continue;
    if (refl.kind !== td.ReflectionKind.TypeAlias) continue;
    if (!isEnumLikeTypeShape(refl.type)) continue;

    const parent = refl.parent;
    if (!parent) continue;
    // Both project and module/namespace parents are ContainerReflections
    // with `.children` of DeclarationReflection. Sibling-by-name lookup.
    const siblings = /** @type {td.DeclarationReflection[] | undefined} */ (/** @type {any} */ (parent).children);
    if (!siblings) continue;

    const constDecl = siblings.find(
      (c) =>
        c !== refl &&
        c.name === refl.name &&
        c.kind === td.ReflectionKind.Variable &&
        c.flags.isConst &&
        isEnumLikeConstShape(c)
    );
    if (!constDecl) continue;

    pairs.push({ constDecl, typeAlias: refl });
  }

  return pairs;
}

/**
 * Match `(typeof X)[keyof typeof X]`.
 *
 * @param {td.SomeType | undefined} type
 */
function isEnumLikeTypeShape(type) {
  if (!(type instanceof td.IndexedAccessType)) return false;
  if (!(type.objectType instanceof td.QueryType)) return false;
  if (!(type.indexType instanceof td.TypeOperatorType)) return false;
  if (type.indexType.operator !== 'keyof') return false;
  if (!(type.indexType.target instanceof td.QueryType)) return false;
  // We don't verify that both QueryTypes point at the same target; the
  // sibling-by-name match downstream catches any mismatch in practice.
  return true;
}

/**
 * Match `as const` object literal of {string|undefined}-valued properties.
 *
 * @param {td.DeclarationReflection} decl
 */
function isEnumLikeConstShape(decl) {
  if (!(decl.type instanceof td.ReflectionType)) return false;
  const children = decl.type.declaration.children;
  if (!children || children.length === 0) return false;
  for (const c of children) {
    if (c.kind !== td.ReflectionKind.Property) return false;
    if (!isLiteralStringOrUndefined(c.type)) return false;
  }
  return true;
}

/** @param {td.SomeType | undefined} t */
function isLiteralStringOrUndefined(t) {
  if (t instanceof td.LiteralType && typeof t.value === 'string') return true;
  if (t instanceof td.IntrinsicType && t.name === 'undefined') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * @param {{ constDecl: td.DeclarationReflection, typeAlias: td.DeclarationReflection }} pair
 * @param {td.ProjectReflection} project
 * @param {td.Application} app
 */
function mergePair({ constDecl, typeAlias }, project, app) {
  const inlineDecl = /** @type {td.ReflectionType} */ (constDecl.type).declaration;
  const allMembers = inlineDecl.children || [];

  const kept = filterMembers(allMembers);
  if (kept.length === 0) {
    app.logger.warn(
      `simplify-enum-likes: ${typeAlias.getFullName()} has no members left after filtering; skipping merge.`
    );
    return;
  }

  // 1. Build a literal union of the unique string values (source order).
  const seen = new Set();
  /** @type {td.SomeType[]} */
  const unionTypes = [];
  for (const c of kept) {
    if (!(c.type instanceof td.LiteralType)) continue;
    const v = c.type.value;
    if (typeof v !== 'string' || seen.has(v)) continue;
    seen.add(v);
    unionTypes.push(new td.LiteralType(v));
  }
  typeAlias.type = unionTypes.length === 1 ? unionTypes[0] : new td.UnionType(unionTypes);

  // 2. Copy the const's comment to the alias if the alias has nothing useful.
  if ((!typeAlias.comment || !typeAlias.comment.hasVisibleComponent()) && constDecl.comment) {
    typeAlias.comment = constDecl.comment.clone();
  }

  // 3. Append a "Values" section if any kept member has descriptive content.
  const valuesParts = buildValuesSection(kept);
  if (valuesParts.length > 0) {
    if (!typeAlias.comment) typeAlias.comment = new td.Comment([]);
    typeAlias.comment.summary.push(...valuesParts);
  }

  // 4. Retarget references that pointed at the const or its members.
  retargetReferences(project, constDecl, inlineDecl, allMembers, typeAlias);

  // 5. Remove the const. TypeDoc's removeReflection cascades to children
  //    (the inline ReflectionType.declaration and its properties).
  project.removeReflection(constDecl);
}

/**
 * Filter rule — see top-of-file docstring for the spec.
 *
 * @param {td.DeclarationReflection[]} children
 * @returns {td.DeclarationReflection[]}
 */
function filterMembers(children) {
  // 1. Drop undefined-valued members.
  const stringValued = children.filter((c) => c.type instanceof td.LiteralType && typeof c.type.value === 'string');

  // 2. Group by value; identify canonical per group (shortest key, ties by source order).
  /** @type {Map<string, td.DeclarationReflection[]>} */
  const groups = new Map();
  for (const c of stringValued) {
    const v = /** @type {string} */ (/** @type {td.LiteralType} */ (c.type).value);
    const bucket = groups.get(v);
    if (bucket) bucket.push(c);
    else groups.set(v, [c]);
  }

  /** @type {Set<td.DeclarationReflection>} */
  const canonicals = new Set();
  for (const bucket of groups.values()) {
    // bucket is already in source order (children was; filter preserves it).
    let canonical = bucket[0];
    for (let i = 1; i < bucket.length; i++) {
      if (bucket[i].name.length < canonical.name.length) canonical = bucket[i];
    }
    canonicals.add(canonical);
  }

  return stringValued.filter((c) => canonicals.has(c) || !isDeprecated(c));
}

/** @param {td.Reflection} refl */
function isDeprecated(refl) {
  return refl.comment?.getTag('@deprecated') !== undefined;
}

// ---------------------------------------------------------------------------
// Values section (strategy β — markdown injection)
// ---------------------------------------------------------------------------

/**
 * Build the "Values" section as a CommentDisplayPart sequence. Returns []
 * if no kept member has any descriptive content (so plain enums render as
 * just the union header with no redundant value list).
 *
 * Embedded {@link …} parts in member comments are carried over verbatim, so
 * inline tags continue to resolve through TypeDoc's normal link machinery.
 *
 * @param {td.DeclarationReflection[]} kept
 * @returns {td.CommentDisplayPart[]}
 */
function buildValuesSection(kept) {
  if (!kept.some(memberHasDescriptiveContent)) return [];

  /** @type {td.CommentDisplayPart[]} */
  const out = [];
  out.push({ kind: 'text', text: '\n\n**Values:**\n' });

  for (const c of kept) {
    const literal = c.type instanceof td.LiteralType ? JSON.stringify(c.type.value) : c.name;
    out.push({ kind: 'text', text: `\n- \`${literal}\`` });

    /** @type {td.CommentDisplayPart[]} */
    const desc = [];
    const summary = c.comment?.summary;
    if (summary && summary.length > 0 && td.Comment.combineDisplayParts(summary).trim() !== '') {
      desc.push(...td.Comment.cloneDisplayParts(summary));
    }

    const deprecated = c.comment?.getTag('@deprecated');
    if (deprecated) {
      if (desc.length > 0) desc.push({ kind: 'text', text: ' ' });
      desc.push({ kind: 'text', text: '**Deprecated.** ' });
      desc.push(...td.Comment.cloneDisplayParts(deprecated.content));
    }

    const isDefault = c.comment?.getTag('@default') !== undefined || c.comment?.modifierTags.has('@default') === true;
    if (isDefault) {
      if (desc.length > 0) desc.push({ kind: 'text', text: ' ' });
      desc.push({ kind: 'text', text: '*(default)*' });
    }

    if (desc.length > 0) {
      out.push({ kind: 'text', text: ' — ' });
      out.push(...collapseToInline(desc));
    }
  }

  return out;
}

/** @param {td.DeclarationReflection} c */
function memberHasDescriptiveContent(c) {
  const com = c.comment;
  if (!com) return false;
  if (com.summary && td.Comment.combineDisplayParts(com.summary).trim() !== '') return true;
  if (com.getTag('@deprecated')) return true;
  if (com.getTag('@default')) return true;
  if (com.modifierTags.has('@default')) return true;
  return false;
}

/**
 * Collapse newlines inside text parts to single spaces, so each value row
 * stays on one markdown list-item line. Inline-tag and code parts pass
 * through untouched.
 *
 * @param {td.CommentDisplayPart[]} parts
 * @returns {td.CommentDisplayPart[]}
 */
function collapseToInline(parts) {
  /** @type {td.CommentDisplayPart[]} */
  const out = [];
  for (const p of parts) {
    if (p.kind === 'text') {
      const collapsed = p.text.replace(/\s+/g, ' ');
      if (collapsed !== '') out.push({ kind: 'text', text: collapsed });
    } else {
      out.push(p);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reference retargeting
// ---------------------------------------------------------------------------

/**
 * Walk every reflection in the project and retarget any ReferenceType (in
 * type trees) or InlineTagDisplayPart (in comments) that pointed at the
 * const, its inline declaration, or one of its member properties — to
 * point at the surviving type alias instead.
 *
 * We match references by reflection id and by symbol stable key. The
 * symbol-key fallback covers references that were resolved by symbol
 * (`ReflectionSymbolId`) rather than by reflection id, which can happen
 * with re-exports and after-removal lookups.
 *
 * @param {td.ProjectReflection} project
 * @param {td.DeclarationReflection} constDecl
 * @param {td.DeclarationReflection} inlineDecl
 * @param {td.DeclarationReflection[]} memberChildren
 * @param {td.DeclarationReflection} typeAlias
 */
function retargetReferences(project, constDecl, inlineDecl, memberChildren, typeAlias) {
  /** @type {Set<number>} */
  const ids = new Set();
  ids.add(constDecl.id);
  ids.add(inlineDecl.id);
  for (const c of memberChildren) ids.add(c.id);

  /** @type {Set<string>} */
  const symKeys = new Set();
  const addSym = (/** @type {td.Reflection} */ r) => {
    const id = project.getSymbolIdFromReflection(r);
    if (id) symKeys.add(id.getStableKey());
  };
  addSym(constDecl);
  addSym(inlineDecl);
  for (const c of memberChildren) addSym(c);

  for (const refl of Object.values(project.reflections)) {
    retargetInReflection(refl, ids, symKeys, typeAlias);
  }
}

/**
 * @param {td.Reflection} refl
 * @param {Set<number>} ids
 * @param {Set<string>} symKeys
 * @param {td.DeclarationReflection} typeAlias
 */
function retargetInReflection(refl, ids, symKeys, typeAlias) {
  if (refl instanceof td.DeclarationReflection) {
    refl.type = retargetType(refl.type, ids, symKeys, typeAlias);
    retargetTypeArray(refl.extendedTypes, ids, symKeys, typeAlias);
    retargetTypeArray(refl.implementedTypes, ids, symKeys, typeAlias);
  } else if (refl instanceof td.SignatureReflection) {
    refl.type = retargetType(refl.type, ids, symKeys, typeAlias);
  } else if (refl instanceof td.ParameterReflection) {
    refl.type = retargetType(refl.type, ids, symKeys, typeAlias);
  } else if (refl instanceof td.TypeParameterReflection) {
    refl.type = retargetType(refl.type, ids, symKeys, typeAlias);
    refl.default = retargetType(refl.default, ids, symKeys, typeAlias);
  }
  if (refl.comment) retargetComment(refl.comment, ids, symKeys, typeAlias);
}

/** @param {td.SomeType[] | undefined} arr */
function retargetTypeArray(arr, ids, symKeys, typeAlias) {
  if (!arr) return;
  for (let i = 0; i < arr.length; i++) {
    arr[i] = /** @type {td.SomeType} */ (retargetType(arr[i], ids, symKeys, typeAlias));
  }
}

/**
 * @param {td.SomeType | undefined} t
 * @param {Set<number>} ids
 * @param {Set<string>} symKeys
 * @param {td.DeclarationReflection} typeAlias
 * @returns {td.SomeType | undefined}
 */
function retargetType(t, ids, symKeys, typeAlias) {
  if (!t) return t;

  if (t instanceof td.ReferenceType) {
    if (referenceMatches(t, ids, symKeys)) {
      return td.ReferenceType.createResolvedReference(typeAlias.name, typeAlias, typeAlias.project);
    }
    if (t.typeArguments) {
      for (let i = 0; i < t.typeArguments.length; i++) {
        t.typeArguments[i] = /** @type {td.SomeType} */ (retargetType(t.typeArguments[i], ids, symKeys, typeAlias));
      }
    }
    return t;
  }

  switch (t.type) {
    case 'array':
      t.elementType = /** @type {td.SomeType} */ (retargetType(t.elementType, ids, symKeys, typeAlias));
      return t;
    case 'conditional':
      t.checkType = /** @type {td.SomeType} */ (retargetType(t.checkType, ids, symKeys, typeAlias));
      t.extendsType = /** @type {td.SomeType} */ (retargetType(t.extendsType, ids, symKeys, typeAlias));
      t.trueType = /** @type {td.SomeType} */ (retargetType(t.trueType, ids, symKeys, typeAlias));
      t.falseType = /** @type {td.SomeType} */ (retargetType(t.falseType, ids, symKeys, typeAlias));
      return t;
    case 'indexedAccess':
      t.objectType = /** @type {td.SomeType} */ (retargetType(t.objectType, ids, symKeys, typeAlias));
      t.indexType = /** @type {td.SomeType} */ (retargetType(t.indexType, ids, symKeys, typeAlias));
      return t;
    case 'inferred':
      if (t.constraint) t.constraint = /** @type {td.SomeType} */ (retargetType(t.constraint, ids, symKeys, typeAlias));
      return t;
    case 'intersection':
      t.types = t.types.map((x) => /** @type {td.SomeType} */ (retargetType(x, ids, symKeys, typeAlias)));
      return t;
    case 'mapped':
      t.parameterType = /** @type {td.SomeType} */ (retargetType(t.parameterType, ids, symKeys, typeAlias));
      t.templateType = /** @type {td.SomeType} */ (retargetType(t.templateType, ids, symKeys, typeAlias));
      if (t.nameType) t.nameType = /** @type {td.SomeType} */ (retargetType(t.nameType, ids, symKeys, typeAlias));
      return t;
    case 'namedTupleMember':
      t.element = /** @type {td.SomeType} */ (retargetType(t.element, ids, symKeys, typeAlias));
      return t;
    case 'optional':
      t.elementType = /** @type {td.SomeType} */ (retargetType(t.elementType, ids, symKeys, typeAlias));
      return t;
    case 'predicate':
      if (t.targetType) t.targetType = /** @type {td.SomeType} */ (retargetType(t.targetType, ids, symKeys, typeAlias));
      return t;
    case 'query': {
      const r = retargetType(t.queryType, ids, symKeys, typeAlias);
      if (r instanceof td.ReferenceType) t.queryType = r;
      return t;
    }
    case 'reflection':
      // Embedded DeclarationReflection is visited via the outer reflection loop.
      return t;
    case 'rest':
      t.elementType = /** @type {td.SomeType} */ (retargetType(t.elementType, ids, symKeys, typeAlias));
      return t;
    case 'templateLiteral':
      t.tail = t.tail.map(
        ([sub, s]) => /** @type {[td.SomeType, string]} */ ([retargetType(sub, ids, symKeys, typeAlias), s])
      );
      return t;
    case 'tuple':
      t.elements = t.elements.map((x) => /** @type {td.SomeType} */ (retargetType(x, ids, symKeys, typeAlias)));
      return t;
    case 'typeOperator':
      t.target = /** @type {td.SomeType} */ (retargetType(t.target, ids, symKeys, typeAlias));
      return t;
    case 'union':
      t.types = t.types.map((x) => /** @type {td.SomeType} */ (retargetType(x, ids, symKeys, typeAlias)));
      return t;
    default:
      return t;
  }
}

/**
 * @param {td.ReferenceType} ref
 * @param {Set<number>} ids
 * @param {Set<string>} symKeys
 */
function referenceMatches(ref, ids, symKeys) {
  const resolved = ref.reflection;
  if (resolved && ids.has(resolved.id)) return true;
  const symId = ref.symbolId;
  if (symId && symKeys.has(symId.getStableKey())) return true;
  // Last resort: read the internal `_target` slot, in case the resolved
  // reflection has been removed between when the reference was created and
  // now (e.g. by an earlier plugin). Same trick `elide-to.mjs` uses.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internalTarget = /** @type {any} */ (ref)._target;
  if (typeof internalTarget === 'number' && ids.has(internalTarget)) return true;
  return false;
}

/**
 * @param {td.Comment} comment
 * @param {Set<number>} ids
 * @param {Set<string>} symKeys
 * @param {td.DeclarationReflection} typeAlias
 */
function retargetComment(comment, ids, symKeys, typeAlias) {
  for (const part of comment.summary) retargetInlineTagPart(part, ids, symKeys, typeAlias);
  for (const tag of comment.blockTags) {
    for (const part of tag.content) retargetInlineTagPart(part, ids, symKeys, typeAlias);
  }
}

/**
 * @param {td.CommentDisplayPart} part
 * @param {Set<number>} ids
 * @param {Set<string>} symKeys
 * @param {td.DeclarationReflection} typeAlias
 */
function retargetInlineTagPart(part, ids, symKeys, typeAlias) {
  if (part.kind !== 'inline-tag') return;
  const target = part.target;
  if (target instanceof td.Reflection) {
    if (ids.has(target.id)) part.target = typeAlias;
  } else if (target instanceof td.ReflectionSymbolId) {
    if (symKeys.has(target.getStableKey())) part.target = typeAlias;
  }
}
