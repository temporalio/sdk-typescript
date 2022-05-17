export function inWorkflowEnv(): boolean {
  return (globalThis as any).__TEMPORAL__ !== undefined;
}
