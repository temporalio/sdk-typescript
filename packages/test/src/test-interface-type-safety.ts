import test from 'ava';
import { defineSignal, defineQuery } from '@temporalio/workflow';

test('SignalDefinition Name type safety', () => {
  // @ts-expect-error Assert expect a type error when generic and concrete names do not match
  defineSignal<[string], 'mismatch'>('illegal value');

  const signalA = defineSignal<[string], 'a'>('a');
  const signalB = defineSignal<[string], 'b'>('b');

  // @ts-expect-error Assert expect a type error when attempting to intermix named signal types
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const cannotIntermixNames: typeof signalA = signalB;
});

test('SignalDefinition Args type safety', () => {
  const signalString = defineSignal<[string]>('a');
  const signalNumber = defineSignal<[number]>('b');

  // @ts-expect-error Assert expect a type error when attempting to intermix named signal types
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const cannotIntermixArgTypes: typeof signalString = signalNumber;
});

test('QueryDefinition Name type safety', () => {
  // @ts-expect-error Assert expect a type error when generic and concrete names do not match
  defineQuery<void, [string], 'mismatch'>('illegal value');

  const queryA = defineQuery<void, [string], 'a'>('a');
  const queryB = defineQuery<void, [string], 'b'>('b');

  // @ts-expect-error Assert expect a type error when attempting to intermix named query types
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const cannotIntermixNames: typeof queryA = queryB;
});

test('QueryDefinition Args and Ret type safety', () => {
    const retVariantA = defineQuery<string>('a');
    const retVariantB = defineQuery<number>('b');
  
    // @ts-expect-error Assert expect a type error when attempting to intermix queries with different return types
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const cannotIntermixRetTypes: typeof retVariantA = retVariantB;

    const argVariantA = defineQuery<string, [number]>('a');
    const argVariantB = defineQuery<string, [string]>('b');
  
    // @ts-expect-error Assert expect a type error when attempting to intermix queries with different arg types
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const cannotIntermixRetTypes: typeof argVariantA = argVariantB;
});
