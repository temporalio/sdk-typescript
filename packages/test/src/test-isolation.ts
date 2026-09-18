import type { ExecutionContext, ImplementationFn } from 'ava';
import { ApplicationFailure, arrayFromPayloads } from '@temporalio/common';
import * as wf from '@temporalio/workflow';
import { WorkflowFailedError } from '@temporalio/client';
import type { Context } from './helpers-integration';
import { makeTestFunction, helpers } from './helpers-integration';
import { isBun, REUSE_V8_CONTEXT } from './helpers';
import {
  globalThisMutatorWorkflow,
  modulePropertyMutator,
  sdkGlobalsReassignment,
  sdkModuleMutatorWorkflow,
  sdkPropertyMutatorWorkflow1,
  v8BuiltinGlobalFunctionMutatorWorkflow,
  v8BuiltinGlobalFunctionPrototypeReassignWorkflow,
  v8BuiltinGlobalFunctionReassignWorkflow,
  v8BuiltinGlobalObjectMutatorWorkflow,
  v8BuiltinGlobalObjectReassignWorkflow,
} from './workflows/isolation';

const test = makeTestFunction({
  workflowInterceptorModules: [require.resolve('./workflows/isolation')],
});

const withReusableContext = test.macro<[ImplementationFn<[], Context>]>(async (t, fn) => {
  if (!REUSE_V8_CONTEXT) {
    t.pass('Skipped since REUSE_V8_CONTEXT is set to false');
    return;
  }
  await fn(t);
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test('globalThis can be safely mutated - misc string property', async (t) => {
  await assertObjectSafelyMutable(t, globalThisMutatorWorkflow, 'myProperty');
});

test('globalThis can be safely mutated - numeric index property', async (t) => {
  await assertObjectSafelyMutable(t, globalThisMutatorWorkflow, 0);
});

test('globalThis can be safely mutated - symbol property', async (t) => {
  await assertObjectSafelyMutable(t, globalThisMutatorWorkflow, Symbol.for('mySymbol'));
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test("V8's built-in global objects are frozen", withReusableContext, async (t) => {
  await assertObjectImmutable(t, v8BuiltinGlobalObjectMutatorWorkflow);
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test("V8's built-in global objects can be safely reassigned", withReusableContext, async (t) => {
  await assertObjectSafelyMutable(t, v8BuiltinGlobalObjectReassignWorkflow);
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test("V8's built-in global functions are frozen", withReusableContext, async (t) => {
  await assertObjectImmutable(t, v8BuiltinGlobalFunctionMutatorWorkflow);
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test("V8's built-in global functions can be safely reassigned", withReusableContext, async (t) => {
  await assertObjectSafelyMutable(t, v8BuiltinGlobalFunctionReassignWorkflow);
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test(
  "V8's built-in global function's prototypes are mutable, without safety guarantees",
  withReusableContext,
  async (t) => {
    await assertObjectUnsafelyMutable(t, v8BuiltinGlobalFunctionPrototypeReassignWorkflow);
  }
);

////////////////////////////////////////////////////////////////////////////////////////////////////

test("SDK's global functions can be reassigned", async (t) => {
  await assertObjectSafelyMutable(t, sdkGlobalsReassignment);
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test("SDK's modules are frozen", withReusableContext, async (t) => {
  await assertObjectSafelyMutable(t, sdkModuleMutatorWorkflow);
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test("SDK's API functions are frozen 1", withReusableContext, async (t) => {
  await assertObjectImmutable(t, sdkPropertyMutatorWorkflow1);
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test('Module state is isolated and maintained between activations', async (t) => {
  await assertObjectSafelyMutable(t, modulePropertyMutator);
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// Utils
////////////////////////////////////////////////////////////////////////////////////////////////////

async function assertObjectSafelyMutable(
  t: ExecutionContext<Context>,
  workflow: (prop: string) => Promise<(number | null)[]>,
  property: string | symbol | number = 'a'
): Promise<void> {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const [wf1Result, wf2Result] = await Promise.all([
      executeWorkflow(workflow, { args: [encodeProperty(property)] }),
      executeWorkflow(workflow, { args: [encodeProperty(property)] }),
    ]);
    const wf1Step = wf1Result.shift() ?? 1;
    const wf2Step = wf2Result.shift() ?? 1;
    t.deepEqual(
      wf1Result,
      [null, 1, 1, 2, 2, null, null, 1].map((x) => x && x * wf1Step)
    );
    t.deepEqual(
      wf2Result,
      [null, 1, 1, 2, 2, null, null, 1].map((x) => x && x * wf2Step)
    );
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
    // Bun uses a different error message format for non-extensible objects
    const expectedMessage = isBun
      ? 'Attempting to define property on object that is not extensible.'
      : 'Cannot add property a, object is not extensible';
    t.is(err?.cause?.message, expectedMessage);
    t.deepEqual((err?.cause as ApplicationFailure)?.details, [[null]]);
  });
}

async function assertObjectUnsafelyMutable(
  t: ExecutionContext<Context>,
  workflow: (prop: string) => Promise<(number | null)[]>,
  property: string | symbol | number = 'a'
): Promise<void> {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    await executeWorkflow(workflow, { args: [encodeProperty(property)] });
    await executeWorkflow(workflow, { args: [encodeProperty(property)] });
  });
  // That's it; if the test didn't throw, it passed.
  t.pass();
}

function encodeProperty(prop: string | symbol | number): string {
  if (typeof prop === 'symbol') return `symbol:${String(prop)}`;
  if (typeof prop === 'number') return `number:${prop}`;
  return prop;
}
