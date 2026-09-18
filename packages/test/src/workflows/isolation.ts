import { ApplicationFailure, arrayFromPayloads } from '@temporalio/common';
import * as wf from '@temporalio/workflow';

export async function globalThisMutatorWorkflow(prop: string): Promise<(number | null)[]> {
  return basePropertyMutatorWorkflow(() => globalThis as any, decodeProperty(prop));
}

export async function v8BuiltinGlobalObjectMutatorWorkflow(): Promise<(number | null)[]> {
  return basePropertyMutatorWorkflow(() => globalThis.Math);
}

export async function v8BuiltinGlobalObjectReassignWorkflow(): Promise<(number | null)[]> {
  globalThis.Math = Object.create(globalThis.Math);
  return basePropertyMutatorWorkflow(() => globalThis.Math);
}

export async function v8BuiltinGlobalFunctionMutatorWorkflow(): Promise<(number | null)[]> {
  return basePropertyMutatorWorkflow(() => globalThis.Array as any);
}

export async function v8BuiltinGlobalFunctionReassignWorkflow(): Promise<(number | null)[]> {
  const originalArray = globalThis.Array;
  globalThis.Array = ((...args: any[]) => originalArray(...args)) as any;
  globalThis.Array.from = ((...args: any[]) => (originalArray as any).from(...args)) as any;
  return basePropertyMutatorWorkflow(() => globalThis.Array);
}

export async function v8BuiltinGlobalFunctionPrototypeReassignWorkflow(): Promise<(number | null)[]> {
  return basePropertyMutatorWorkflow(() => globalThis.Array.prototype);
}

export async function sdkGlobalsReassignment(): Promise<(number | null)[]> {
  // The SDK's provided `console` object is frozen.
  // Replace that global with a clone that is not frozen.
  globalThis.console = { ...globalThis.console };
  return basePropertyMutatorWorkflow(() => globalThis.console);
}

export async function sdkModuleMutatorWorkflow(): Promise<(number | null)[]> {
  return basePropertyMutatorWorkflow(() => wf as any);
}

export async function sdkPropertyMutatorWorkflow1(): Promise<(number | null)[]> {
  return basePropertyMutatorWorkflow(() => arrayFromPayloads as any);
}

export const moduleScopedObject: any = {};

export async function modulePropertyMutator(): Promise<(number | null)[]> {
  return basePropertyMutatorWorkflow(() => moduleScopedObject);
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
export async function basePropertyMutatorWorkflow(
  getObject: () => any,
  prop: string | symbol | number = 'a'
): Promise<(number | null)[]> {
  // Randomly choose some step to add to the property; there's a 10% chance that two workflows in
  // a same test run will get the same step, and that's really not a problem (the test is still valid).
  // But getting different steps at least once in a while confirms that our test methodology isn't
  // prone to false positives due to the two racing workflows turn out to be producing the very same
  // sequence of values at exactly the same time.
  const step = [1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000, 1000000000][
    Math.floor(Math.random() * 10)
  ];

  const checkpoints: (number | null)[] = [step];

  // Very important: do not cache the result of getObject() to a local variable;
  // in some scenarios, caching would defeat the purpose of this test.
  try {
    checkpoints.push(getObject()[prop]); // Expect null
    getObject()[prop] = (getObject()[prop] || 0) + step;
    checkpoints.push(getObject()[prop]); // Expect 1*step

    await wf.sleep(1);

    checkpoints.push(getObject()[prop]); // Expect 1*step
    getObject()[prop] = (getObject()[prop] || 0) + step;
    checkpoints.push(getObject()[prop]); // Expect 2*step

    await wf.sleep(1);

    checkpoints.push(getObject()[prop]); // Expect 2*step
    delete getObject()[prop];
    checkpoints.push(getObject()[prop]); // Expect null

    await wf.sleep(1);

    checkpoints.push(getObject()[prop]); // Expect null
    getObject()[prop] = (getObject()[prop] || 0) + step;
    checkpoints.push(getObject()[prop]); // Expect 1*step

    return checkpoints;
  } catch (e) {
    throw ApplicationFailure.fromError(e, { details: [checkpoints.slice(1)] });
  }
}

export function decodeProperty(prop: string): string | symbol | number {
  if (prop.startsWith('symbol:')) return Symbol.for(prop.slice(7));
  if (prop.startsWith('number:')) return Number(prop.slice(7));
  return prop;
}
