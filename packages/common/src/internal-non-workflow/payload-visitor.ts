import type { coresdk } from '@temporalio/proto';
import {
  walkWorkflowActivation,
  walkWorkflowActivationCompletion,
  type WalkEnv,
} from '@temporalio/proto/lib/payload-visitor.generated';
import type { Payload } from '../interfaces';

/**
 * Called for each payload-bearing field in a message.
 *
 * @internal
 * @experimental
 */
export type PayloadTransform<Ctx> = (
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
 * @internal
 * @experimental
 */
export interface VisitOptions<Ctx> {
  payloadTransform: PayloadTransform<Ctx>;
  deriveContext?: ContextDeriver<Ctx>;
  /** Context in scope before any message is entered. */
  initialContext?: Ctx;
  /** Max payload-transform calls in flight at once, across all sites. Default 1 (sequential). */
  concurrency?: number;
  skipHeaders?: boolean;
  skipSearchAttributes?: boolean;
  /** Aborts the walk; composed with the internal cancel-on-error signal and handed to the transform. */
  abortSignal?: AbortSignal;
}

/**
 * A simple counting semaphore.
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
 * Wraps a {@link PayloadTransform} so at most `concurrency` calls run at once. The first rejection
 * aborts the rest via the `failure` controller.
 *
 * @internal
 * @experimental
 */
export function boundPayloadTransform<Ctx>(
  transform: PayloadTransform<Ctx>,
  concurrency: number,
  failure: AbortController
): (payloads: Payload[], context: Ctx) => Promise<Payload[]> {
  const semaphore = new Semaphore(Math.max(1, concurrency));

  return async (payloads, context) => {
    failure.signal.throwIfAborted();
    await semaphore.acquire();
    try {
      failure.signal.throwIfAborted();
      return await transform(payloads, context, failure.signal);
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

/**
 * Runs a recursive walk using the VisitOptions. The transform in the VisitOptions is concurrency
 * bounded here and assigned to {@link WalkEnv}.
 *
 * @internal
 * @experimental
 */
async function runVisit<Ctx>(
  options: VisitOptions<Ctx>,
  walk: (env: WalkEnv<Ctx>, context: Ctx) => Promise<unknown>[]
): Promise<void> {
  const {
    payloadTransform,
    deriveContext,
    initialContext,
    concurrency = 1,
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

  const env: WalkEnv<Ctx> = {
    transform: boundPayloadTransform(payloadTransform, concurrency, failure),
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
 * Applies `payloadTransform` to every {@link Payload} in a `WorkflowActivation`, mutating it in place.
 *
 * @internal
 * @experimental
 */
export function visitWorkflowActivation<Ctx = void>(
  root: coresdk.workflow_activation.IWorkflowActivation,
  options: VisitOptions<Ctx>
): Promise<void> {
  return runVisit(options, (env, context) => walkWorkflowActivation(root, env, context));
}

/**
 * Applies `payloadTransform` to every {@link Payload} in a `WorkflowActivationCompletion`, mutating it
 * in place.
 *
 * @internal
 * @experimental
 */
export function visitWorkflowActivationCompletion<Ctx = void>(
  root: coresdk.workflow_completion.IWorkflowActivationCompletion,
  options: VisitOptions<Ctx>
): Promise<void> {
  return runVisit(options, (env, context) => walkWorkflowActivationCompletion(root, env, context));
}
