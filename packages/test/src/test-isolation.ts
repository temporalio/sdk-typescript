import { ExecutionContext, ImplementationFn } from 'ava';
import { ApplicationFailure, arrayFromPayloads } from '@temporalio/common';
import * as wf from '@temporalio/workflow';
import { WorkflowFailedError } from '@temporalio/client';
import { makeTestFunction, Context, helpers } from './helpers-integration';
import { REUSE_V8_CONTEXT } from './helpers';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
});

const withReusableContext = test.macro<[ImplementationFn<[], Context>]>(async (t, fn) => {
  if (!REUSE_V8_CONTEXT) {
    t.pass('Skipped since REUSE_V8_CONTEXT is set to false');
    return;
  }
  await fn(t);
});

////////////////////////////////////////////////////////////////////////////////////////////////////

// Legacy
test('globalThis can be safely mutated - misc string property', async (t) => {
  await assertObjectSafelyMutable(t, globalThisMutatorWorkflow, 'myProperty');
});

// New
test('globalThis can be safely mutated - numeric index property', async (t) => {
  await assertObjectSafelyMutable(t, globalThisMutatorWorkflow, 0);
});

// New
test('globalThis can be safely mutated - symbol property', async (t) => {
  await assertObjectSafelyMutable(t, globalThisMutatorWorkflow, Symbol.for('mySymbol'));
});

export async function globalThisMutatorWorkflow(prop: string): Promise<(number | null)[]> {
  return basePropertyMutatorWorkflow(() => globalThis as any, decodeProperty(prop));
}

////////////////////////////////////////////////////////////////////////////////////////////////////

// Original test was broken because it mutated `setTimeout`, which is overridden by the SDK
test("V8's built-in global objects are frozen", withReusableContext, async (t) => {
  await assertObjectImmutable(t, v8BuiltinGlobalObjectMutatorWorkflow);
});

export async function v8BuiltinGlobalObjectMutatorWorkflow(): Promise<(number | null)[]> {
  return basePropertyMutatorWorkflow(() => globalThis.Math);
}

////////////////////////////////////////////////////////////////////////////////////////////////////

test("V8's built-in global objects can be safely reassigned", withReusableContext, async (t) => {
  await assertObjectSafelyMutable(t, v8BuiltinGlobalObjectReassignWorkflow);
});

export async function v8BuiltinGlobalObjectReassignWorkflow(): Promise<(number | null)[]> {
  try {
    globalThis.Math = Object.create(globalThis.Math);
    return basePropertyMutatorWorkflow(() => globalThis.Math);
  } catch (e) {
    if (!(e instanceof ApplicationFailure)) {
      throw ApplicationFailure.fromError(e);
    }
    throw e;
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

test("V8's built-in global functions are frozen", withReusableContext, async (t) => {
  await assertObjectImmutable(t, v8BuiltinGlobalFunctionMutatorWorkflow);
});

export async function v8BuiltinGlobalFunctionMutatorWorkflow(): Promise<(number | null)[]> {
  return basePropertyMutatorWorkflow(() => globalThis.Array as any);
}

////////////////////////////////////////////////////////////////////////////////////////////////////

test("V8's built-in global functions can be safely reassigned", withReusableContext, async (t) => {
  await assertObjectSafelyMutable(t, v8BuiltinGlobalFunctionReassignWorkflow);
});

export async function v8BuiltinGlobalFunctionReassignWorkflow(): Promise<(number | null)[]> {
  try {
    const originalArray = globalThis.Array;
    globalThis.Array = ((...args: any[]) => originalArray(...args)) as any;
    globalThis.Array.from = ((...args: any[]) => (originalArray as any).from(...args)) as any;
    return basePropertyMutatorWorkflow(() => globalThis.Array);
  } catch (e) {
    if (!(e instanceof ApplicationFailure)) {
      throw ApplicationFailure.fromError(e);
    }
    throw e;
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

// V8's built-in global functions prototype can be unsafely mutated

// FIXME: What about built-in function prototypes?
//        They are often modified by polyfills, which would be loaded as part
//        of Workflow Code…
// await assertObjectImmutable(t, v8BuiltinGlobalFunctionReassignWorkflow);

////////////////////////////////////////////////////////////////////////////////////////////////////

test("SDK's global functions can be reassigned", async (t) => {
  await assertObjectSafelyMutable(t, sdkGlobalsReassignment);
});

export async function sdkGlobalsReassignment(): Promise<(number | null)[]> {
  try {
    // The SDK's provided `console` object is frozen.
    // Replace that global with a clone that is not frozen.
    globalThis.console = { ...globalThis.console };
    return basePropertyMutatorWorkflow(() => globalThis.console);
  } catch (e) {
    if (!(e instanceof ApplicationFailure)) {
      throw ApplicationFailure.fromError(e);
    }
    throw e;
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

test("SDK's modules are frozen", withReusableContext, async (t) => {
  await assertObjectSafelyMutable(t, sdkModuleMutatorWorkflow);
});

export async function sdkModuleMutatorWorkflow(): Promise<(number | null)[]> {
  return basePropertyMutatorWorkflow(() => wf as any);
}

////////////////////////////////////////////////////////////////////////////////////////////////////

// Legacy
test("SDK's API functions are frozen 1", withReusableContext, async (t) => {
  await assertObjectImmutable(t, sdkPropertyMutatorWorkflow1);
});

export async function sdkPropertyMutatorWorkflow1(): Promise<(number | null)[]> {
  return basePropertyMutatorWorkflow(() => arrayFromPayloads as any);
}

////////////////////////////////////////////////////////////////////////////////////////////////////

// Legacy
test('Module state is isolated and maintained between activations', async (t) => {
  await assertObjectSafelyMutable(t, modulePropertyMutator);
});

const moduleScopedObject: any = {};
export async function modulePropertyMutator(): Promise<(number | null)[]> {
  return basePropertyMutatorWorkflow(() => moduleScopedObject);
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Utils
////////////////////////////////////////////////////////////////////////////////////////////////////

async function assertObjectSafelyMutable(
  t: ExecutionContext<Context>,
  workflow: (prop: string) => Promise<(number | null)[]>,
  property: string | symbol | number = 'a'
): Promise<void> {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wf1 = await startWorkflow(workflow, { args: [encodeProperty(property)] });
    const wf2 = await startWorkflow(workflow, { args: [encodeProperty(property)] });
    t.deepEqual(await wf1.result(), [null, 1, 1, 2, 2, null, null, 1]);
    t.deepEqual(await wf2.result(), [null, 1, 1, 2, 2, null, null, 1]);
  });
}

async function assertObjectImmutable(
  t: ExecutionContext<Context>,
  workflow: () => Promise<(number | null)[]>
): Promise<void> {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wf1 = await startWorkflow(workflow);
    const err = await t.throwsAsync(wf1.result(), { instanceOf: WorkflowFailedError });
    t.is(err?.cause?.message, 'Cannot add property a, object is not extensible');
    t.deepEqual((err?.cause as ApplicationFailure)?.details, [[null]]);
  });
}

// Given the object returned by `getObject()`, this function can be used to
// assert any of these three possible scenarios:
//  1. The object can't be mutated from Workflows (i.e. the object is frozen);
//     - or -
//  2. The object can be safetly mutated from Workflows, meaning that:
//     2.1. Can add new properties to the object (i.e. the object is not frozen);
//     2.2. Properties added on the object from one workflow execution don't leak to other workflows;
//     2.3. Properties added on the object from one workflow are maintained between activations of that workflow;
//     2.4. Properties added then deleted from the object don't reappear on subsequent activations.
//     - or -
//  3. The object can be mutated from Workflows, without isolation guarantees.
//     This last case is notably desirable
async function basePropertyMutatorWorkflow(
  getObject: () => any,
  prop: string | symbol | number = 'a'
): Promise<(number | null)[]> {
  const checkpoints: (number | null)[] = [];

  // FIXME: Also cover symbol properties

  // Very important: do not cache the result of getObject() to a local variable;
  // in some scenarios, caching would defeat the purpose of this test.
  try {
    checkpoints.push(getObject()[prop]); // Expect null
    getObject()[prop] = (getObject()[prop] || 0) + 1;
    checkpoints.push(getObject()[prop]); // Expect 1

    await wf.sleep(1);

    checkpoints.push(getObject()[prop]); // Expect 1
    getObject()[prop] = (getObject()[prop] || 0) + 1;
    checkpoints.push(getObject()[prop]); // Expect 2

    await wf.sleep(1);

    checkpoints.push(getObject()[prop]); // Expect 2
    delete getObject()[prop];
    checkpoints.push(getObject()[prop]); // Expect null

    await wf.sleep(1);

    checkpoints.push(getObject()[prop]); // Expect null
    getObject()[prop] = (getObject()[prop] || 0) + 1;
    checkpoints.push(getObject()[prop]); // Expect 1

    return checkpoints;
  } catch (e) {
    throw ApplicationFailure.fromError(e, { details: [checkpoints] });
  }
}

function encodeProperty(prop: string | symbol | number): string {
  if (typeof prop === 'symbol') return `symbol:${String(prop)}`;
  if (typeof prop === 'number') return `number:${prop}`;
  return prop;
}

function decodeProperty(prop: string): string | symbol | number {
  if (prop.startsWith('symbol:')) return Symbol.for(prop.slice(7));
  if (prop.startsWith('number:')) return Number(prop.slice(7));
  return prop;
}
