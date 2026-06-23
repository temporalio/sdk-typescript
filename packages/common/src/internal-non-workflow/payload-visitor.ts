import type { coresdk } from '@temporalio/proto';
import {
  walkWorkflowActivation,
  walkWorkflowActivationCompletion,
} from '@temporalio/proto/lib/payload-visitor.generated';
import type { Payload } from '../interfaces';

/**
 * Receives the payloads found at one payload-bearing field of a proto message and returns
 * their replacements. The input array MAY have length 0, and the returned array MUST have the
 * same length.
 *
 * `abortSignal` fires when the walk is aborted or when a sibling site's transform rejects.
 *
 * @internal
 * @experimental
 */
export type PayloadTransform = (payloads: Payload[], abortSignal?: AbortSignal) => Promise<Payload[]>;

/**
 * @internal
 * @experimental
 */
export interface VisitOptions {
  /**
   * Maximum number of {@link PayloadTransform} calls in flight at once, across all sites in
   * the message. Defaults to 1, in which case sites are visited sequentially.
   */
  concurrency?: number;

  /**
   * Aborts the walk. Already-running transforms are awaited (never left running in the
   * background) and not-yet-started ones are skipped.
   */
  abortSignal?: AbortSignal;
}

/**
 * A counting semaphore. `acquire` resolves once a permit is available; `release` returns one,
 * handing it directly to the longest-waiting acquirer if any.
 */
class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter();
    } else {
      this.permits += 1;
    }
  }
}

/**
 * Wraps a {@link PayloadTransform} so that at most `concurrency` transformations run at once.
 * The first rejection aborts the rest via `failure` AbortController and subsequent calls are
 * skipped.
 *
 * @internal
 * @experimental
 */
export function boundTransform(
  transform: PayloadTransform,
  concurrency: number,
  failure: AbortController
): PayloadTransform {
  const semaphore = new Semaphore(Math.max(1, concurrency));

  return async (payloads) => {
    failure.signal.throwIfAborted();
    await semaphore.acquire();
    try {
      failure.signal.throwIfAborted();
      return await transform(payloads, failure.signal);
    } catch (reason) {
      failure.abort(reason);
      throw reason;
    } finally {
      semaphore.release();
    }
  };
}

/**
 * Awaits every promise a walk produced, then throws the first rejection in traversal order.
 * `allSettled` guarantees no in-flight transform is left running on the error path.
 *
 * @internal
 * @experimental
 */
export async function drain(pending: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(pending);
  for (const result of results) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
  }
}

async function runVisit<Root>(
  walk: (root: Root, transform: PayloadTransform) => Promise<unknown>[],
  root: Root,
  transform: PayloadTransform,
  { concurrency = 1, abortSignal }: VisitOptions = {}
): Promise<void> {
  const abortController = new AbortController();
  let removeListener: (() => void) | undefined;
  if (abortSignal) {
    if (abortSignal.aborted) {
      abortController.abort(abortSignal.reason);
    } else {
      const onAbort = () => abortController.abort(abortSignal.reason);
      abortSignal.addEventListener('abort', onAbort, { once: true });
      removeListener = () => abortSignal.removeEventListener('abort', onAbort);
    }
  }
  try {
    await drain(walk(root, boundTransform(transform, concurrency, abortController)));
  } finally {
    removeListener?.();
  }
}

/**
 * Applies `transform` to every {@link Payload} in a `WorkflowActivation`, mutating it in place.
 *
 * @internal
 * @experimental
 */
export function visitWorkflowActivation(
  root: coresdk.workflow_activation.IWorkflowActivation,
  transform: PayloadTransform,
  options?: VisitOptions
): Promise<void> {
  return runVisit(walkWorkflowActivation, root, transform, options);
}

/**
 * Applies `transform` to every {@link Payload} in a `WorkflowActivationCompletion`, mutating it
 * in place.
 *
 * @internal
 * @experimental
 */
export function visitWorkflowActivationCompletion(
  root: coresdk.workflow_completion.IWorkflowActivationCompletion,
  transform: PayloadTransform,
  options?: VisitOptions
): Promise<void> {
  return runVisit(walkWorkflowActivationCompletion, root, transform, options);
}
