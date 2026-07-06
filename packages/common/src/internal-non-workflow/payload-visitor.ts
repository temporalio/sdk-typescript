import type { coresdk } from '@temporalio/proto';
import {
  walkWorkflowActivation,
  walkWorkflowActivationCompletion,
  type WalkEnv,
} from '@temporalio/proto/lib/payload-visitor.generated';
import type { Semaphore } from '../semaphore';
import type { Payload } from '../interfaces';

/**
 * Called for each singular (or map-value) payload-bearing field. One payload in, one out.
 *
 * @internal
 * @experimental
 */
export type PayloadTransform<Ctx> = (payload: Payload, context: Ctx, abortSignal?: AbortSignal) => Promise<Payload>;

/**
 * Called for each payload-bearing field that may contain multiple payloads (e.g. Payloads or repeated fields).
 * May return any number of payloads, including zero.
 *
 * @internal
 * @experimental
 */
export type PayloadsTransform<Ctx> = (
  payloads: Payload[],
  context: Ctx,
  abortSignal?: AbortSignal
) => Promise<Payload[]>;

/**
 * Called on entering each message and returns the context for its children.
 *
 * @internal
 * @experimental
 */
export type ContextDeriver<Ctx> = (message: object, typeName: string, context: Ctx) => Ctx;

/**
 * Two transform functions are required because some fields require a single (non-null) payload while others
 * are simply lists.
 *
 * @internal
 * @experimental
 */
export interface VisitOptions<Ctx> {
  transformPayload: PayloadTransform<Ctx>;
  transformPayloads: PayloadsTransform<Ctx>;
  deriveContext?: ContextDeriver<Ctx>;
  /** Context in scope before any message is entered. */
  initialContext?: Ctx;
  /**
   * Optional semaphore bounding how many transform calls run at once. When set, both transforms are
   * wrapped with it. Reuse one instance across visits for a global limit (e.g. a payload store's
   * total budget). Omit for unbounded fan-out within the visit. Do not also pre-wrap the transforms
   * with this same semaphore, as that double-acquires per call.
   */
  semaphore?: Semaphore;
  skipHeaders?: boolean;
  skipSearchAttributes?: boolean;
  /** Aborts the walk; composed with the internal cancel-on-error signal and handed to the transform. */
  abortSignal?: AbortSignal;
}

/**
 * Wraps a payload transform so its calls acquire a permit from `semaphore` before running, bounding
 * how many run at once. Reuse one `Semaphore` instance across visits for a global limit. The abort
 * signal is forwarded so a visit's cancel-on-error still reaches the transform.
 *
 * @internal
 * @experimental
 */
export function boundPayloadTransform<In, Out, Ctx>(
  transform: (input: In, context: Ctx, abortSignal?: AbortSignal) => Promise<Out>,
  semaphore: Semaphore
): (input: In, context: Ctx, abortSignal?: AbortSignal) => Promise<Out> {
  return async (input, context, abortSignal) => {
    await semaphore.acquire();
    try {
      return await transform(input, context, abortSignal);
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

/**
 * Runs a recursive walk from the VisitOptions. Optionally bounds each transform with the supplied
 * semaphore, then wraps them with the per-visit cancel-on-error signal and assigns them to
 * {@link WalkEnv}.
 *
 * @internal
 * @experimental
 */
async function runVisit<Ctx>(
  options: VisitOptions<Ctx>,
  walk: (env: WalkEnv<Ctx>, context: Ctx) => Promise<unknown>[]
): Promise<void> {
  const {
    transformPayload,
    transformPayloads,
    deriveContext,
    initialContext,
    semaphore,
    skipHeaders = false,
    skipSearchAttributes = false,
    abortSignal,
  } = options;

  const failure = new AbortController();
  let removeListener: (() => void) | undefined;
  if (abortSignal) {
    if (abortSignal.aborted) {
      failure.abort(abortSignal.reason);
    } else {
      const onAbort = () => failure.abort(abortSignal.reason);
      abortSignal.addEventListener('abort', onAbort, { once: true });
      removeListener = () => abortSignal.removeEventListener('abort', onAbort);
    }
  }

  const boundedPayload = semaphore ? boundPayloadTransform(transformPayload, semaphore) : transformPayload;
  const boundedPayloads = semaphore ? boundPayloadTransform(transformPayloads, semaphore) : transformPayloads;

  const abortSiblingsOnError = async <T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    failure.signal.throwIfAborted();
    try {
      return await call(failure.signal);
    } catch (reason) {
      failure.abort(reason);
      throw reason;
    }
  };

  const env: WalkEnv<Ctx> = {
    transformPayload: (payload, context) => abortSiblingsOnError((signal) => boundedPayload(payload, context, signal)),
    transformPayloads: (payloads, context) =>
      abortSiblingsOnError((signal) => boundedPayloads(payloads, context, signal)),
    deriveContext,
    skipHeaders,
    skipSearchAttributes,
  };
  try {
    await drain(walk(env, initialContext as Ctx));
  } finally {
    removeListener?.();
  }
}

/**
 * Applies the payload transforms to every {@link Payload} in a `WorkflowActivation`, mutating it in place.
 *
 * @internal
 * @experimental
 */
export async function visitWorkflowActivation<Ctx = void>(
  root: coresdk.workflow_activation.IWorkflowActivation,
  options: VisitOptions<Ctx>
): Promise<void> {
  return runVisit(options, (env, context) => walkWorkflowActivation(root, env, context));
}

/**
 * Applies the payload transforms to every {@link Payload} in a `WorkflowActivationCompletion`, mutating
 * it in place.
 *
 * @internal
 * @experimental
 */
export async function visitWorkflowActivationCompletion<Ctx = void>(
  root: coresdk.workflow_completion.IWorkflowActivationCompletion,
  options: VisitOptions<Ctx>
): Promise<void> {
  return runVisit(options, (env, context) => walkWorkflowActivationCompletion(root, env, context));
}
