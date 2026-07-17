import type { coresdk } from '@temporalio/proto';
import {
  walkActivityTask,
  walkActivityTaskCompletion,
  walkNexusTask,
  walkNexusTaskCompletion,
  walkWorkflowActivation,
  walkWorkflowActivationCompletion,
  type WalkEnv,
} from '@temporalio/proto/lib/payload-visitor.generated';
import { sequential, type ConcurrencyLimit } from '../concurrency/limit';
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
   * Optional concurrency limit applied to every transform call. Share one limit across visits for a
   * global cap (e.g. a payload store's total budget), or nest limits to compose a per-visit cap under
   * a global one. Omit to run transforms one at a time (sequential).
   */
  limit?: ConcurrencyLimit;
  skipHeaders?: boolean;
  skipSearchAttributes?: boolean;
  /** Aborts the walk; composed with the internal cancel-on-error signal and handed to the transform. */
  abortSignal?: AbortSignal;
}

/**
 * Awaits every promise a walk produced, then throws the first rejection in traversal order.
 * `allSettled` guarantees no in-flight transform is left running on the error path.
 */
async function drain(pending: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(pending);
  for (const result of results) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
  }
}

/**
 * Runs a recursive walk from the VisitOptions. Runs each transform through the concurrency limit,
 * then wraps them with the per-visit cancel-on-error signal and assigns them to {@link WalkEnv}.
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
    limit = sequential(),
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
    transformPayload: (payload, context) =>
      abortSiblingsOnError((signal) => limit(() => transformPayload(payload, context, signal))),
    transformPayloads: (payloads, context) =>
      abortSiblingsOnError((signal) => limit(() => transformPayloads(payloads, context, signal))),
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

/**
 * Applies the payload transforms to every {@link Payload} in an `ActivityTask` (activity input and
 * last-recorded heartbeat details), mutating it in place.
 *
 * @internal
 * @experimental
 */
export async function visitActivityTask<Ctx = void>(
  root: coresdk.activity_task.IActivityTask,
  options: VisitOptions<Ctx>
): Promise<void> {
  return runVisit(options, (env, context) => walkActivityTask(root, env, context));
}

/**
 * Applies the payload transforms to every {@link Payload} in an `ActivityTaskCompletion` (the activity
 * result / failure), mutating it in place.
 *
 * @internal
 * @experimental
 */
export async function visitActivityTaskCompletion<Ctx = void>(
  root: coresdk.IActivityTaskCompletion,
  options: VisitOptions<Ctx>
): Promise<void> {
  return runVisit(options, (env, context) => walkActivityTaskCompletion(root, env, context));
}

/**
 * Applies the payload transforms to every {@link Payload} in a `NexusTask`, mutating it in place.
 *
 * @internal
 * @experimental
 */
export async function visitNexusTask<Ctx = void>(
  root: coresdk.nexus.INexusTask,
  options: VisitOptions<Ctx>
): Promise<void> {
  return runVisit(options, (env, context) => walkNexusTask(root, env, context));
}

/**
 * Applies the payload transforms to every {@link Payload} in a `NexusTaskCompletion`, mutating it in
 * place.
 *
 * @internal
 * @experimental
 */
export async function visitNexusTaskCompletion<Ctx = void>(
  root: coresdk.nexus.INexusTaskCompletion,
  options: VisitOptions<Ctx>
): Promise<void> {
  return runVisit(options, (env, context) => walkNexusTaskCompletion(root, env, context));
}
