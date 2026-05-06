import type { WorkerOptions } from '@temporalio/worker';

/** Minimum work time in ms — error if less. */
export const MINIMUM_WORK_TIME_MS = 1000;

/** Low work time threshold in ms — warn if less. */
export const WARN_WORK_TIME_MS = 5000;

/**
 * Default buffer in ms before the Lambda deadline to begin shutdown.
 * Equals the default shutdownGraceTime (5s) + 2s margin.
 */
export const DEFAULT_SHUTDOWN_DEADLINE_BUFFER_MS = 7000;

/**
 * Lambda-tuned worker defaults. These are conservative values appropriate for
 * Lambda's memory and CPU constraints. Users can override any of these via the
 * configure callback.
 */
export const LAMBDA_WORKER_DEFAULTS: Partial<WorkerOptions> = {
  maxConcurrentActivityTaskExecutions: 2,
  maxConcurrentWorkflowTaskExecutions: 10,
  maxConcurrentLocalActivityExecutions: 2,
  maxConcurrentNexusTaskExecutions: 5,
  shutdownGraceTime: '5s',
  maxCachedWorkflows: 30,
  workflowTaskPollerBehavior: { type: 'simple-maximum', maximum: 2 },
  activityTaskPollerBehavior: { type: 'simple-maximum', maximum: 1 },
  nexusTaskPollerBehavior: { type: 'simple-maximum', maximum: 1 },
};
