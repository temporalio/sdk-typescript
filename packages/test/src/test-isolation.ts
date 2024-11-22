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

//

test('globalThis can be safely mutated', async (t) => {
  await assertObjectSafelyMutable(t, globalThisMutatorWorkflow);
});

export async function globalThisMutatorWorkflow(): Promise<(number | null)[]> {
  return basePropertyMutator(() => globalThis as any);
}

//

test("V8's built-in global objects are frozen, but can be safely reassigned", withReusableContext, async (t) => {
  await assertObjectImmutable(t, v8BuiltinGlobalObjectMutatorWorkflow);
  // here
  await assertObjectSafelyMutable(t, v8BuiltinGlobalObjectReassignWorkflow);
});

export async function v8BuiltinGlobalObjectMutatorWorkflow(): Promise<(number | null)[]> {
  return basePropertyMutator(() => globalThis.Math as any);
}

export async function v8BuiltinGlobalObjectReassignWorkflow(): Promise<(number | null)[]> {
  try {
    globalThis.Math = Object.create(globalThis.Math);
    return basePropertyMutator(() => globalThis.Math);
  } catch (e) {
    if (!(e instanceof ApplicationFailure)) {
      throw ApplicationFailure.fromError(e);
    }
    throw e;
  }
}

//

test("V8's built-in global functions are frozen, and can't be reassigned", withReusableContext, async (t) => {
  await assertObjectImmutable(t, v8BuiltinGlobalFunctionMutatorWorkflow);
  await assertObjectImmutable(t, v8BuiltinGlobalFunctionReassignWorkflow);

  // FIXME: What about built-in function prototypes?
  //        They are often modified by polyfills, which would be loaded as part
  //        of Workflow Code…
  await assertObjectImmutable(t, v8BuiltinGlobalFunctionReassignWorkflow);
});

export async function v8BuiltinGlobalFunctionMutatorWorkflow(): Promise<(number | null)[]> {
  return basePropertyMutator(() => globalThis.Array as any);
}

export async function v8BuiltinGlobalFunctionReassignWorkflow(): Promise<(number | null)[]> {
  try {
    const originalArray = globalThis.Array;
    globalThis.Array = ((...args: any[]) => originalArray(...args)) as any;
    return basePropertyMutator(() => globalThis.Array);
  } catch (e) {
    if (!(e instanceof ApplicationFailure)) {
      throw ApplicationFailure.fromError(e);
    }
    throw e;
  }
}

//

// test("SDK's globals can be reassigned", async (t) => {
//   await assertObjectSafelyMutable(t, sdkGlobalsReassignment);
// });

// export async function sdkGlobalsReassignment(): Promise<(number | null)[]> {
//   try {
//     // The SDK's provided `console` object is frozen.
//     // Replace that global with a clone that is not frozen.
//     globalThis.console = { ...globalThis.console };
//     return basePropertyMutator(() => globalThis.console);
//   } catch (e) {
//     if (!(e instanceof ApplicationFailure)) {
//       throw ApplicationFailure.fromError(e);
//     }
//     throw e;
//   }
// }

// //

// test("SDK's API functions are frozen 2", withReusableContext, async (t) => {
//   await assertObjectSafelyMutable(t, sdkPropertyMutatorWorkflow2);
// });

// export async function sdkPropertyMutatorWorkflow2(): Promise<(number | null)[]> {
//   return basePropertyMutator(() => wf as any);
// }

// //

// test("SDK's API functions are frozen 1", withReusableContext, async (t) => {
//   await assertObjectImmutable(t, sdkPropertyMutatorWorkflow1);
// });

// export async function sdkPropertyMutatorWorkflow1(): Promise<(number | null)[]> {
//   return basePropertyMutator(() => arrayFromPayloads as any);
// }

// //

// test('Module state is isolated and maintained between activations', async (t) => {
//   await assertObjectSafelyMutable(t, modulePropertyMutator);
// });

// const moduleScopedObject: any = {};
// export async function modulePropertyMutator(): Promise<(number | null)[]> {
//   return basePropertyMutator(() => moduleScopedObject);
// }

//

async function assertObjectSafelyMutable(
  t: ExecutionContext<Context>,
  workflow: () => Promise<(number | null)[]>
): Promise<void> {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wf1 = await startWorkflow(workflow);
    const wf2 = await startWorkflow(workflow);
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
//  3. The object can be mutable from Workflows, without isolation guarantees.
//     This last case is notably desirable
async function basePropertyMutator(getObject: () => any): Promise<(number | null)[]> {
  const checkpoints: (number | null)[] = [];

  // Very important: do not cache the result of getObject() to a local variable;
  // in some schenario, caching would defeat the purpose of this test.
  try {
    checkpoints.push(getObject().a); // Expect null
    getObject().a = (getObject().a || 0) + 1;
    checkpoints.push(getObject().a); // Expect 1

    await wf.sleep(1);

    checkpoints.push(getObject().a); // Expect 1
    getObject().a = (getObject().a || 0) + 1;
    checkpoints.push(getObject().a); // Expect 2

    await wf.sleep(1);

    checkpoints.push(getObject().a); // Expect 2
    delete getObject().a;
    checkpoints.push(getObject().a); // Expect null

    await wf.sleep(1);

    checkpoints.push(getObject().a); // Expect null
    getObject().a = (getObject().a || 0) + 1;
    checkpoints.push(getObject().a); // Expect 1

    return checkpoints;
  } catch (e) {
    throw ApplicationFailure.fromError(e, { details: [checkpoints] });
  }
}

// Given the object returned by `getObject()`, this function can be used to assert
// either of these two scenarios:
//  1. The object can't be mutated from Workflows (i.e. the object is frozen);
//     - or -
//  2. The object can be safetly mutated from Workflows, meaning that:
//     2.1. Can add new properties to the object (i.e. the object is not frozen);
//     2.2. Properties added on the object from one workflow execution don't leak to other workflows;
//     2.3. Properties added on the object from one workflow are maintained between activations of that workflow;
//     2.4. Properties added then deleted from the object don't reappear on subsequent activations.
// async function basePropertyReassign(getObject: () => any, propName: string): Promise<(number | null)[]> {
//   try {
//     const prop = getObject()[propName];
//     const newProp = cloneObject;
//     getObject()[propName] = newProp;
//     return basePropertyMutator(() => getObject()[propName]);
//   } catch (e) {
//     if (!(e instanceof ApplicationFailure)) {
//       throw ApplicationFailure.fromError(e);
//     }
//     throw e;
//   }
// }
