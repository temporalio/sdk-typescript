import { assertInWorkflowContext } from './global-attributes';
import type { Activator } from './internals';
import { fillWithRandom, uuid4FromRandom } from './random-helpers';

/**
 * A deterministic PRNG stream scoped to the current Workflow execution.
 */
export interface WorkflowRandomStream {
  random(): number;
  uuid4(): string;
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

export function getRandomStream(name: string): WorkflowRandomStream {
  const activator = assertInWorkflowContext('Workflow.getRandomStream(...) may only be used from workflow context.');
  return new ActivatorRandomStream(activator, name);
}

export function withRandomStream<T>(name: string, fn: () => T): T {
  const activator = assertInWorkflowContext('Workflow.withRandomStream(...) may only be used from workflow context.');
  return activator.withCurrentRandom(new ActivatorRandomStream(activator, name), fn);
}
