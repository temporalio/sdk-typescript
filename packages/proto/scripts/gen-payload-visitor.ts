import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import * as protobuf from 'protobufjs';
import * as prettier from 'prettier';

// Generates `packages/proto/src/payload-visitor.generated.ts`: a synchronous walk of the worker
// boundary message trees (WorkflowActivation, ActivityTask, NexusTaskCompletion, ...) that invokes a
// payload visitor at every Payload-bearing field, threading a per-message context. Runs in proto's
// build (and via `pnpm gen:payload-visitor`).

const PAYLOAD = 'temporal.api.common.v1.Payload';
const ANY = 'google.protobuf.Any';

// Namespaces scanned for root messages. Every payload-bearing message declared under these gets an
// exported entry point, so any message can be walked and new messages are covered automatically on
// regen.
const ROOT_NAMESPACES = ['coresdk', 'temporal.api.workflowservice.v1'] as const;

const jsonModule = require(resolve(__dirname, '../protos/json-module.js'));
const root = protobuf.Root.fromJSON(jsonModule);
root.resolveAll();

const fqn = (type: protobuf.Type): string => type.fullName.replace(/^\./, '');
const fnName = (type: protobuf.Type): string => `walk_${fqn(type).replace(/\./g, '_')}`;
// The top-level proto namespace a type lives under, e.g. `coresdk` for `coresdk.workflow_activation.X`.
const topLevelNamespace = (type: protobuf.Type): string => fqn(type).split('.')[0]!;

// The message a field points to, or undefined when the field is a scalar or enum (the only
// fields that can hold a Payload, directly or transitively, are message-typed).
const resolvedMessage = (field: protobuf.Field): protobuf.Type | undefined =>
  field.resolvedType instanceof protobuf.Type ? field.resolvedType : undefined;

const byFqn = (a: protobuf.Type, b: protobuf.Type): number => fqn(a).localeCompare(fqn(b));

/** TS type reference for a message, e.g. `temporal.api.failure.v1.IFailure`. */
function tsType(type: protobuf.Type): string {
  const segments = fqn(type).split('.');
  const last = segments.length - 1;
  segments[last] = `I${segments[last]}`;
  return segments.join('.');
}

/** Collect every message type declared (recursively) under a namespace. */
function collectMessages(obj: protobuf.ReflectionObject, out: protobuf.Type[]): void {
  if (obj instanceof protobuf.Type) out.push(obj);
  if (obj instanceof protobuf.Namespace) {
    for (const child of obj.nestedArray) collectMessages(child, out);
  }
}

// Candidate roots: every message declared under the scanned namespaces.
const candidates: protobuf.Type[] = [];
for (const name of ROOT_NAMESPACES) {
  const ns = root.lookup(name);
  if (!ns) throw new Error(`Root namespace not found: ${name}`);
  collectMessages(ns, candidates);
}

// All message types reachable from the candidates, excluding the terminal Payload and the opaque Any.
const reachableTypes = (): Map<string, protobuf.Type> => {
  const types = new Map<string, protobuf.Type>();
  const discover = (type: protobuf.Type): void => {
    const key = fqn(type);
    if (key === PAYLOAD || key === ANY || types.has(key)) return;
    types.set(key, type);
    for (const field of type.fieldsArray) {
      const message = resolvedMessage(field);
      if (message) discover(message);
    }
  };
  for (const candidate of candidates) discover(candidate);
  return types;
};

const types = reachableTypes();

// Reverse reference index: `referrers.get(X)` is every type that has a field of type X. Used to walk
// back from Payload and mark every type that can transitively contain one.
const referrers = new Map<string, string[]>();
for (const type of types.values()) {
  for (const field of type.fieldsArray) {
    const target = resolvedMessage(field);
    if (!target) continue;
    const list = referrers.get(fqn(target)) ?? [];
    list.push(fqn(type));
    referrers.set(fqn(target), list);
  }
}

// Then, starting from Payload, mark every type that can reach it.
const reachesPayload = new Set<string>();
const toVisit = [PAYLOAD];
while (toVisit.length > 0) {
  const target = toVisit.pop()!;
  for (const referrer of referrers.get(target) ?? []) {
    if (reachesPayload.has(referrer)) continue;
    reachesPayload.add(referrer);
    toVisit.push(referrer);
  }
}

// A message contains a Payload if it is one, or if it was marked above.
const hasPayload = (type: protobuf.Type): boolean => fqn(type) === PAYLOAD || reachesPayload.has(fqn(type));

// Roots: every payload-bearing message declared in the scanned namespaces.
const roots = candidates.filter((type) => hasPayload(type)).sort(byFqn);

const simpleNameCounts = new Map<string, number>();
for (const type of roots) simpleNameCounts.set(type.name, (simpleNameCounts.get(type.name) ?? 0) + 1);
const entryName = (type: protobuf.Type): string =>
  (simpleNameCounts.get(type.name) ?? 0) > 1
    ? `walk${fqn(type)
        .split(/[._]/)
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join('')}`
    : `walk${type.name}`;

// Guard: two roots that share a simple name would collide as exported entry points.
const seenEntries = new Set<string>();
for (const rootType of roots) {
  const name = entryName(rootType);
  if (seenEntries.has(name)) throw new Error(`Duplicate root entry name '${name}' (from ${fqn(rootType)})`);
  seenEntries.add(name);
}

/** Every reachable message type that needs a walker (i.e. can contain a Payload), sorted by name. */
const collectWalkers = (): protobuf.Type[] => [...types.values()].filter(hasPayload).sort(byFqn);

/** Statements for one field's payload sites / recursion, or '' if the field reaches no payload. */
function emitField(field: protobuf.Field): string {
  const message = resolvedMessage(field);
  if (!message || !hasPayload(message)) return '';

  const access = `o.${field.name}`;
  const isPayload = fqn(message) === PAYLOAD;

  let body: string;
  if (isPayload) {
    // Singular and map-value sites use transformPayload (one payload in, one out). Repeated sites use
    // transformPayloads and are replaced by whatever it returns (any count, including empty).
    if (field.map) {
      body = `const m = ${access};
if (m) for (const [k, v] of Object.entries(m)) pending.push(env.transformPayload(v, ctx).then((r) => { m[k] = r; }));`;
    } else if (field.repeated) {
      body = `const a = ${access};
if (a && a.length) pending.push(env.transformPayloads(a, ctx).then((r) => { ${access} = r; }));`;
    } else {
      body = `const p = ${access};
if (p != null) pending.push(env.transformPayload(p, ctx).then((r) => { ${access} = r; }));`;
    }
  } else {
    const walk = fnName(message);
    if (field.map) {
      body = `const m = ${access};
if (m) for (const v of Object.values(m)) ${walk}(v, env, ctx, pending);`;
    } else if (field.repeated) {
      body = `const a = ${access};
if (a) for (const v of a) ${walk}(v, env, ctx, pending);`;
    } else {
      body = `const c = ${access};
if (c != null) ${walk}(c, env, ctx, pending);`;
    }
  }

  if (field.name === 'headers') return `if (!env.skipHeaders) {\n${body}\n}`;
  if (field.name === 'searchAttributes') return `if (!env.skipSearchAttributes) {\n${body}\n}`;
  return body;
}

function emitWalker(type: protobuf.Type): string {
  const blocks = type.fieldsArray
    .map(emitField)
    .filter((body) => body.length > 0)
    .map((body) => `{\n${body}\n}`);
  return [
    `function ${fnName(type)}<Ctx>(o: ${tsType(
      type
    )}, env: WalkEnv<Ctx>, context: Ctx, pending: Promise<unknown>[]): void {`,
    `const ctx = env.deriveContext ? env.deriveContext(o, '${fqn(type)}', context) : context;`,
    ...blocks,
    `}`,
  ].join('\n');
}

function emit(): string {
  const walkers = collectWalkers();
  const namespaces = [...new Set(walkers.map(topLevelNamespace))].sort();

  const entries = roots.map((type) => {
    return [
      `export function ${entryName(type)}<Ctx>(root: ${tsType(
        type
      )}, env: WalkEnv<Ctx>, context: Ctx): Promise<unknown>[] {`,
      `  const pending: Promise<unknown>[] = [];`,
      `  ${fnName(type)}(root, env, context, pending);`,
      `  return pending;`,
      `}`,
    ].join('\n');
  });

  return [
    `// Code generated by packages/proto/scripts/gen-payload-visitor.ts. DO NOT EDIT.`,
    ``,
    `import type { ${namespaces.join(', ')} } from '../protos/root';`,
    ``,
    `type Payload = temporal.api.common.v1.IPayload;`,
    ``,
    `export interface WalkEnv<Ctx> {`,
    `  transformPayload(payload: Payload, context: Ctx): Promise<Payload>;`,
    `  transformPayloads(payloads: Payload[], context: Ctx): Promise<Payload[]>;`,
    `  deriveContext?(message: object, typeName: string, context: Ctx): Ctx;`,
    `  skipHeaders: boolean;`,
    `  skipSearchAttributes: boolean;`,
    `}`,
    ``,
    entries.join('\n\n'),
    ``,
    walkers.map(emitWalker).join('\n\n'),
    ``,
  ].join('\n');
}

const outPath = resolve(__dirname, '../src/payload-visitor.generated.ts');

async function main(): Promise<void> {
  const config = await prettier.resolveConfig(outPath);
  const formatted = await prettier.format(emit(), { ...config, parser: 'typescript' });
  writeFileSync(outPath, formatted);
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
