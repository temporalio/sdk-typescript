import { OperatorFunction, ObservableInput, pipe } from 'rxjs';
import { map, scan, mergeScan } from 'rxjs/operators';

interface StateAndOptionalOutput<T, O> {
  state: T;
  output?: O;
}

export type StateAndOutput<T, O> = Required<StateAndOptionalOutput<T, O>>;

export function mapWithState<T, I, O>(
  fn: (state: T, input: I) => StateAndOutput<T, O>,
  initialState: T
): OperatorFunction<I, O> {
  return pipe(
    scan(({ state }: StateAndOptionalOutput<T, O>, input: I): StateAndOptionalOutput<T, O> => fn(state, input), {
      state: initialState,
    }),
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    map(({ output }) => output!)
  );
}

export function mergeMapWithState<T, I, O>(
  fn: (state: T, input: I) => ObservableInput<StateAndOutput<T, O>>,
  initialState: T,
  concurrency = 1
): OperatorFunction<I, O> {
  return pipe(
    mergeScan(
      ({ state }: StateAndOptionalOutput<T, O>, input: I): ObservableInput<StateAndOptionalOutput<T, O>> =>
        fn(state, input),
      { state: initialState },
      concurrency
    ),
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    map(({ output }) => output!)
  );
}
