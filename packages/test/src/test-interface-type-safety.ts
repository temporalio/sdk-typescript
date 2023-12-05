import test from 'ava';
import { defineSignal, defineQuery, ExternalWorkflowHandle, ChildWorkflowHandle, Workflow } from '@temporalio/workflow';
import { WorkflowHandle } from '@temporalio/client';
import * as wf from '@temporalio/workflow';

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

test('Signal handler type safety', (t) => {
  const signal = defineSignal<[string]>('a');

  wf.setHandler(signal, (_arg: string): void => {});

  // @ts-expect-error signal handler must take string argument
  wf.setHandler(signal, (_arg: number) => {});

  // @ts-expect-error signal handler must take string argument
  wf.setHandler(signal, () => {});

  // @ts-expect-error signal handler must return void
  wf.setHandler(signal, (_arg: string): string => '');

  t.pass();
});

test('Query handler type safety', (t) => {
  const query = defineQuery<string, [string]>('a');

  wf.setHandler(query, (_arg: string): string => '');

  // @ts-expect-error query handler argument type must match
  wf.setHandler(query, (_arg: number): string => '');

  // @ts-expect-error query handler argument type must match
  wf.setHandler(query, (): string => '');

  // @ts-expect-error query handler return type must match
  wf.setHandler(query, (_arg: string): void => {});

  // @ts-expect-error query handler return type must match
  wf.setHandler(query, (_arg: string): number => 7);

  t.pass();
});
