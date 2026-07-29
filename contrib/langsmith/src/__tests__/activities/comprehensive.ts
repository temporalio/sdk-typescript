/**
 * Activities for the comprehensive trace-tree test.
 *
 * @module
 */

import { traceable } from 'langsmith/traceable';

/** Activity body that traces two levels: `comprehensive_activity` → `comprehensive_activity_inner`. */
const comprehensiveActivityImpl = traceable(
  async (input: string): Promise<string> =>
    traceable(async (leaf: string): Promise<string> => `llm:${leaf}`, { name: 'comprehensive_activity_inner' })(input),
  { name: 'comprehensive_activity' }
);

export async function comprehensiveActivity(input: string): Promise<string> {
  return comprehensiveActivityImpl(input);
}

/** A local activity with no instrumentation in its body. */
export async function comprehensiveLocalActivity(input: string): Promise<string> {
  return `local:${input}`;
}

// A module-level promise lets the workflow signal the driver that it has finished
// its outbound boundaries and is ready for handler calls, keeping the emitted tree
// deterministic.
let readyResolve: (() => void) | undefined;

/** Called by the test before starting the workflow; returns a fresh "ready" promise. */
export function resetReady(): Promise<void> {
  return new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
}

/** Run by the workflow once its outbound boundaries are done. */
export async function notifyReady(): Promise<void> {
  readyResolve?.();
}
