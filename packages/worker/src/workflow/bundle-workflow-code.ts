import type { BundleOptions, WorkflowBundleWithSourceMap } from './bundler';

/**
 * Create a bundle to pass to {@link WorkerOptions.workflowBundle}. Helpful for reducing Worker startup time in
 * production.
 *
 * When using with {@link Worker.runReplayHistory}, make sure to pass the same interceptors and payload converter used
 * when the history was generated.
 */
export async function bundleWorkflowCode(options: BundleOptions): Promise<WorkflowBundleWithSourceMap> {
  // The bundler is loaded on demand, so that importing `@temporalio/worker` does not load webpack.
  const bundler = await import('./bundler');
  return await bundler.bundleWorkflowCode(options);
}
