/**
 * `@temporalio/langsmith` — LangSmith observability for Temporal.
 *
 * Add {@link LangSmithPlugin} to your `Client` and `Worker` and your existing
 * `traceable` (from `langsmith/traceable`) instrumentation works **unchanged**
 * inside workflows and activities, with correct run parenting across the
 * workflow → activity → child-workflow → Nexus boundaries.
 *
 * ```ts
 * import { traceable } from 'langsmith/traceable';
 * import { LangSmithPlugin } from '@temporalio/langsmith';
 *
 * // unchanged user instrumentation — runs the same inside a workflow/activity:
 * const inner = traceable(async (x: string) => callModel(x), { name: 'inner_llm_call' });
 *
 * const worker = await Worker.create({
 *   workflowsPath: require.resolve('./workflows'),
 *   taskQueue: 'tq',
 *   plugins: [new LangSmithPlugin({ addTemporalRuns: true })],
 * });
 * ```
 *
 * @module
 */

export { LangSmithPlugin } from './plugin';
export type { LangSmithPluginOptions } from './plugin';
export { createLangSmithSinks } from './sinks';
export type { LangSmithSinks, SerializedRun } from './sinks';
