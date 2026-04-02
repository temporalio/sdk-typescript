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
}

/**
 * Get a named deterministic random stream for the current workflow execution.
 *
 * Named streams are derived from the workflow seed and a stable stream name,
 * without consuming the workflow's default `Math.random()` stream. Repeated
 * calls with the same `name` within a workflow execution refer to the same
 * logical stream state, including across activations.
 *
 * This is the preferred API for workflow plugins and interceptors that need
 * their own deterministic entropy. Use stable package- or module-style names
 * so the stream identity remains replay-safe.
 */
export function getRandomStream(name: string): WorkflowRandomStream {
  const activator = assertInWorkflowContext('Workflow.getRandomStream(...) may only be used from workflow context.');
  return new ActivatorRandomStream(activator, name);
}

/**
 * Run `fn` with `Math.random()` and other scoped workflow-random helpers routed
 * through a named deterministic stream.
 *
 * This is intended for bounded plugin/interceptor scopes that need existing code
 * calling `Math.random()` or `uuid4()` to use a plugin-private stream without
 * perturbing the workflow's default random stream. The scope follows async
 * continuations spawned by `fn`.
 *
 * Workflow interceptor `next(...)` continuations restore the downstream workflow
 * random scope before running the rest of the interceptor chain or workflow code.
 * That keeps a temporary plugin scope from leaking into downstream workflow logic.
 *
 * Prefer {@link getRandomStream} for new code when explicit stream usage is
 * practical; use this helper when a temporary scoped override is the better fit.
 */
export function withRandomStream<T>(name: string, fn: () => T): T {
  const activator = assertInWorkflowContext('Workflow.withRandomStream(...) may only be used from workflow context.');
  return activator.withCurrentRandom(new ActivatorRandomStream(activator, name), fn);
}
