import test from 'ava';
import {
  defineSignal,
  defineQuery,
  ExternalWorkflowHandle,
  ChildWorkflowHandle,
  Workflow,
  defineUpdate,
} from '@temporalio/workflow';
import { WorkflowHandle } from '@temporalio/client';

test('SignalDefinition Name type safety', (t) => {
  // @ts-expect-error Assert expect a type error when generic and concrete names do not match
  defineSignal<[string], 'mismatch'>('illegal value');

  const signalA = defineSignal<[string], 'a'>('a');
  const signalB = defineSignal<[string], 'b'>('b');

  type TypeAssertion = typeof signalB extends typeof signalA ? 'intermixable' : 'not-intermixable';

  const _assertion: TypeAssertion = 'not-intermixable';
  t.pass();
});

test('SignalDefinition Args type safety', (t) => {
  const signalString = defineSignal<[string]>('a');
  const signalNumber = defineSignal<[number]>('b');

  type TypeAssertion = typeof signalNumber extends typeof signalString ? 'intermixable' : 'not-intermixable';

  const _assertion: TypeAssertion = 'not-intermixable';
  t.pass();
});

test('QueryDefinition Name type safety', (t) => {
  // @ts-expect-error Assert expect a type error when generic and concrete names do not match
  defineQuery<void, [string], 'mismatch'>('illegal value');

  const queryA = defineQuery<void, [string], 'a'>('a');
  const queryB = defineQuery<void, [string], 'b'>('b');

  type TypeAssertion = typeof queryB extends typeof queryA ? 'intermixable' : 'not-intermixable';

  const _assertion: TypeAssertion = 'not-intermixable';
  t.pass();
});

test('QueryDefinition Args and Ret type safety', (t) => {
  const retVariantA = defineQuery<string>('a');
  const retVariantB = defineQuery<number>('b');

  type RetTypeAssertion = typeof retVariantB extends typeof retVariantA ? 'intermixable' : 'not-intermixable';

  const _retAssertion: RetTypeAssertion = 'not-intermixable';

  const argVariantA = defineQuery<string, [number]>('a');
  const argVariantB = defineQuery<string, [string]>('b');

  type ArgTypeAssertion = typeof argVariantB extends typeof argVariantA ? 'intermixable' : 'not-intermixable';

  const _argAssertion: ArgTypeAssertion = 'not-intermixable';
  t.pass();
});

test('UpdateDefinition Name type safety', (t) => {
  // @ts-expect-error Assert expect a type error when generic and concrete names do not match
  defineUpdate<void, [string], 'mismatch'>('illegal value');

  const updateA = defineUpdate<void, [string], 'a'>('a');
  const updateB = defineUpdate<void, [string], 'b'>('b');

  type TypeAssertion = typeof updateB extends typeof updateA ? 'intermixable' : 'not-intermixable';

  const _assertion: TypeAssertion = 'not-intermixable';
  t.pass();
});

test('UpdateDefinition Args and Ret type safety', (t) => {
  const retVariantA = defineUpdate<string>('a');
  const retVariantB = defineUpdate<number>('b');

  type RetTypeAssertion = typeof retVariantB extends typeof retVariantA ? 'intermixable' : 'not-intermixable';

  const _retAssertion: RetTypeAssertion = 'not-intermixable';

  const argVariantA = defineUpdate<string, [number]>('a');
  const argVariantB = defineUpdate<string, [string]>('b');

  type ArgTypeAssertion = typeof argVariantB extends typeof argVariantA ? 'intermixable' : 'not-intermixable';

  const _argAssertion: ArgTypeAssertion = 'not-intermixable';
  t.pass();
});

test('Can call signal on any WorkflowHandle', async (t) => {
  // This function definition is an assertion by itself. TSC will throw a compile time error if
  // the signature of the signal function is not compatible across all WorkflowHandle variants.
  async function _assertion<T extends Workflow>(
    handle: WorkflowHandle<T> | ChildWorkflowHandle<T> | ExternalWorkflowHandle
  ) {
    await handle.signal(defineSignal('signal'));
  }

  t.pass();
});

test('startUpdate and executeUpdate call signatures require `args` iff update takes args', async (t) => {
  const nullaryUpdate = defineUpdate<string>('my-update');
  const unaryUpdate = defineUpdate<string, [number]>('my-update');

  async function _assertion<T extends Workflow>(handle: WorkflowHandle<T>) {
    await handle.startUpdate(nullaryUpdate);
    await handle.startUpdate(nullaryUpdate, {});
    await handle.startUpdate(nullaryUpdate, { args: [] });
    await handle.executeUpdate(nullaryUpdate);
    await handle.executeUpdate(nullaryUpdate, {});
    await handle.executeUpdate(nullaryUpdate, { args: [] });
    // @ts-expect-error
    await handle.startUpdate(unaryUpdate);
    // @ts-expect-error
    await handle.startUpdate(unaryUpdate, {});
    // @ts-expect-error
    await handle.startUpdate(unaryUpdate, { args: [] });
    // @ts-expect-error
    await handle.executeUpdate(unaryUpdate);
    // @ts-expect-error
    await handle.executeUpdate(unaryUpdate, {});
    // @ts-expect-error
    await handle.executeUpdate(unaryUpdate, { args: [] });
  }
  t.pass();
});
