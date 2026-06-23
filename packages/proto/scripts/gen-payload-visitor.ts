import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import * as protobuf from 'protobufjs';
import * as prettier from 'prettier';

// Generates `@temporalio/common`'s `internal-non-workflow/payload-visitor.generated.ts`: a
// synchronous walk of the WorkflowActivation / WorkflowActivationCompletion message trees that
// calls a PayloadTransform at every Payload-bearing field.
// Run explicitly via `pnpm gen:payload-visitor`.

const PAYLOAD = 'temporal.api.common.v1.Payload';
const ANY = 'google.protobuf.Any';

const ROOTS = [
  { type: 'coresdk.workflow_activation.WorkflowActivation', entry: 'walkWorkflowActivation' },
  { type: 'coresdk.workflow_completion.WorkflowActivationCompletion', entry: 'walkWorkflowActivationCompletion' },
] as const;

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

// All message types reachable from the roots, excluding the terminal Payload and the opaque Any.
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
  for (const { type } of ROOTS) discover(root.lookupType(type));
  return types;
};

const types = reachableTypes();

// Which of those types can contain a Payload, directly or nested inside another message? We work
// backwards from Payload. First index the reverse references: `referrers.get(X)` is every type
// that has a field of type X.
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

/** Every reachable message type that needs a walker (i.e. can contain a Payload), sorted by name. */
const collectWalkers = (): protobuf.Type[] => [...types.values()].filter(hasPayload).sort(byFqn);

/** Lines of the walker body for one field, or [] if the field reaches no payload. */
function emitField(field: protobuf.Field): string[] {
  const message = resolvedMessage(field);
  if (!message || !hasPayload(message)) return [];

  const access = `o.${field.name}`;
  const isPayload = fqn(message) === PAYLOAD;

  if (isPayload) {
    if (field.map) {
      return [
        `const m = ${access};`,
        `if (m) for (const [k, v] of Object.entries(m)) pending.push(visit([v]).then((r) => { m[k] = one(r); }));`,
      ];
    }
    if (field.repeated) {
      return [
        `const a = ${access};`,
        `if (a && a.length) pending.push(visit(a).then((r) => { ${access} = many(r, a.length); }));`,
      ];
    }
    return [`const p = ${access};`, `if (p != null) pending.push(visit([p]).then((r) => { ${access} = one(r); }));`];
  }

  const walk = fnName(message);
  if (field.map) {
    return [`const m = ${access};`, `if (m) for (const v of Object.values(m)) ${walk}(v, visit, pending);`];
  }
  if (field.repeated) {
    return [`const a = ${access};`, `if (a) for (const v of a) ${walk}(v, visit, pending);`];
  }
  return [`const c = ${access};`, `if (c != null) ${walk}(c, visit, pending);`];
}

function emitWalker(type: protobuf.Type): string {
  // Each field's statements get their own `{ }` block so the emitted per-field locals don't
  // collide. Indentation is left to prettier, which formats the generated file afterward.
  const blocks = type.fieldsArray
    .map(emitField)
    .filter((lines) => lines.length > 0)
    .map((lines) => `{\n${lines.join('\n')}\n}`);
  return [
    `function ${fnName(type)}(o: ${tsType(type)}, visit: Visit, pending: Promise<unknown>[]): void {`,
    ...blocks,
    `}`,
  ].join('\n');
}

// Prepended to the generated file. `one`/`many` enforce that a transform returns exactly as
// many payloads as it received, failing loudly instead of silently corrupting the message.
const RUNTIME_HELPERS = `
function one(payloads: Payload[]): Payload {
  if (payloads.length !== 1) {
    throw new Error(\`payload visitor: a singular field transform returned \${payloads.length} payloads, expected 1\`);
  }
  return payloads[0]!;
}

function many(payloads: Payload[], expected: number): Payload[] {
  if (payloads.length !== expected) {
    throw new Error(\`payload visitor: a repeated field transform returned \${payloads.length} payloads, expected \${expected}\`);
  }
  return payloads;
}`;

function emit(): string {
  const walkers = collectWalkers();
  const namespaces = [...new Set(walkers.map(topLevelNamespace))].sort();

  const entries = ROOTS.map(({ type, entry }) => {
    const t = root.lookupType(type);
    return [
      `export function ${entry}(root: ${tsType(t)}, visit: Visit): Promise<unknown>[] {`,
      `  const pending: Promise<unknown>[] = [];`,
      `  ${fnName(t)}(root, visit, pending);`,
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
    `type Visit = (payloads: Payload[], abortSignal?: AbortSignal) => Promise<Payload[]>;`,
    RUNTIME_HELPERS,
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
