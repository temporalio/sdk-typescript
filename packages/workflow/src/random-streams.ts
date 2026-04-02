import { assertInWorkflowContext } from './global-attributes';
import type { Activator } from './internals';
import { fillWithRandom, uuid4FromRandom } from './random-helpers';

/**
 * A deterministic PRNG stream scoped to the current Workflow execution.
 *
 * Workflow code already gets a deterministic default stream through `Math.random()`.
 * This interface exposes additional named streams that are derived from the workflow
 * seed without consuming that default stream. Repeated calls to
 * {@link getRandomStream} with the same name refer to the same logical stream state
 * for the current workflow execution, and that state is preserved across activations.
 *
 * The primary use case is workflow plugins and interceptors that need private,
 * replay-stable entropy without perturbing user workflow randomness.
 */
export interface WorkflowRandomStream {
  /**
   * Draw the next deterministic pseudo-random number from this stream.
   *
   * This is equivalent to `Math.random()`, but isolated from the workflow's main
   * random stream and from other named streams.
   */
  random(): number;

  /**
   * Generate a deterministic UUIDv4 backed by this stream.
   */
  uuid4(): string;

  /**
   * Fill a byte array deterministically from this stream.
   */
  fill(bytes: Uint8Array): Uint8Array;

  /**
   * Run `fn` with scoped workflow-random helpers such as `Math.random()` and `uuid4()`
   * routed through this stream.
   *
   * This is the scoped override API for workflow random streams. It is intended for
   * bounded plugin/interceptor code that needs existing calls to `Math.random()` or
   * `uuid4()` to use this stream without perturbing the workflow's default random
   * sequence or any other named stream.
   *
   * The override follows async continuations started by `fn`. Workflow interceptor
   * `next(...)` continuations restore the downstream workflow random scope before
   * entering the rest of the interceptor chain or workflow code, so a temporary
   * plugin scope does not leak downstream unless that downstream code explicitly
   * establishes its own scope.
   *
   * Prefer explicit `stream.random()` / `stream.uuid4()` calls when that is practical.
   * Use `stream.with(...)` when a temporary scoped override is the better fit, or
   * when you want to keep the stream instance in module scope and reuse it directly.
   */
  with<T>(fn: () => T): T;
}

class ActivatorRandomStream implements WorkflowRandomStream {
  constructor(
    protected readonly activator: Activator,
    protected readonly name: string
  ) {}

  random(): number {
    // TODO: Cache the resolved RNG on this wrapper once named-stream reseeding can refresh cached streams safely.
    return this.activator.getNamedRandom(this.name)();
  }

  uuid4(): string {
    return uuid4FromRandom(() => this.random());
  }

  fill(bytes: Uint8Array): Uint8Array {
    return fillWithRandom(() => this.random(), bytes);
  }

  with<T>(fn: () => T): T {
    return this.activator.withCurrentRandom(this, fn);
  }
}

class DefaultWorkflowRandomStream implements WorkflowRandomStream {
  random(): number {
    return assertInWorkflowContext('Workflow.workflowRandom may only be used from workflow context.').random();
  }

  uuid4(): string {
    return uuid4FromRandom(() => this.random());
  }

  fill(bytes: Uint8Array): Uint8Array {
    return fillWithRandom(() => this.random(), bytes);
  }

  with<T>(fn: () => T): T {
    const activator = assertInWorkflowContext('Workflow.workflowRandom may only be used from workflow context.');
    return activator.withCurrentRandom(this, fn);
  }
}

/**
 * The default deterministic random stream for the current workflow execution.
 *
 * This exposes the same underlying sequence used by workflow-level `Math.random()`
 * when no named override is active. It can be useful for plugin/interceptor code
 * that wants an explicit handle to the main workflow random stream, including from
 * inside a temporary named scope established by another `WorkflowRandomStream`.
 */
export const workflowRandom: WorkflowRandomStream = new DefaultWorkflowRandomStream();

/**
 * Get a named deterministic random stream for the current workflow execution.
 *
 * Named streams are derived from the workflow seed and a stable stream name,
 * without consuming the workflow's default `Math.random()` stream. Repeated
 * calls with the same `name` within a workflow execution refer to the same
 * logical stream state, including across activations.
 *
 * This is the preferred entry point for workflow plugins and interceptors that
 * need their own deterministic entropy. Use stable package- or module-style
 * names so the stream identity remains replay-safe, then keep the returned
 * `WorkflowRandomStream` around and call its methods directly.
 */
export function getRandomStream(name: string): WorkflowRandomStream {
  const activator = assertInWorkflowContext('Workflow.getRandomStream(...) may only be used from workflow context.');
  return new ActivatorRandomStream(activator, name);
}
