import { GroupedObservable, ObservableInput, OperatorFunction, pipe, Subject } from 'rxjs';
import { groupBy, map, mergeScan, scan } from 'rxjs/operators';

interface StateAndOptionalOutput<T, O> {
  state: T;
  output?: O;
}

export type StateAndOutput<T, O> = Required<StateAndOptionalOutput<T, O>>;

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

export interface CloseableGroupedObservable<K, T> extends GroupedObservable<K, T> {
  close(): void;
}

/**
 * An RX OperatorFunction similar to `groupBy`.
 * The returned GroupedObservable has a `close()` method.
 */
export function closeableGroupBy<K extends string | number | undefined, T>(
  keyFunc: (t: T) => K
): OperatorFunction<T, CloseableGroupedObservable<K, T>> {
  const keyToSubject = new Map<K, Subject<void>>();
  return pipe(
    groupBy(keyFunc, {
      duration: (group$) => {
        // Duration selector function, the group will close when this subject emits a value
        const subject = new Subject<void>();
        keyToSubject.set(group$.key, subject);
        return subject;
      },
    }),
    map((group$: GroupedObservable<K, T>): CloseableGroupedObservable<K, T> => {
      (group$ as CloseableGroupedObservable<K, T>).close = () => {
        const subject = keyToSubject.get(group$.key);
        if (subject !== undefined) {
          subject.next();
          keyToSubject.delete(group$.key);
        }
      };
      return group$ as CloseableGroupedObservable<K, T>;
    })
  );
}
