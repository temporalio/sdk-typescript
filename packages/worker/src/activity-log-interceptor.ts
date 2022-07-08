import { Context, Info } from '@temporalio/activity';
import { ActivityInboundCallsInterceptor, ActivityExecuteInput, Next } from './interceptors';
import { Logger } from './logger';

const UNINITIAILIZED = Symbol('UNINITIAILIZED');

/**
 * Returns a map of attributes to be set on log messages for a given Activity
 */
export function activityLogAttributes(info: Info): Record<string, unknown> {
  return {
    isLocal: info.isLocal,
    attempt: info.attempt,
    namespace: info.workflowNamespace,
    taskToken: info.base64TaskToken,
    workflowId: info.workflowExecution.workflowId,
    workflowRunId: info.workflowExecution.runId,
    workflowType: info.workflowType,
    activityId: info.activityId,
    activityType: info.activityType,
    taskQueue: info.taskQueue,
  };
}

/** Logs Activity execution starts and their completions */
export class ActivityInboundLogInterceptor implements ActivityInboundCallsInterceptor {
  constructor(protected readonly ctx: Context, protected readonly logger: Logger) {}

  protected logAttributes(): Record<string, unknown> {
    return activityLogAttributes(this.ctx.info);
  }

  async execute(input: ActivityExecuteInput, next: Next<ActivityInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    let error: any = UNINITIAILIZED; // In case someone decides to throw undefined...
    const startTime = process.hrtime.bigint();
    this.logger.debug('Activity started', this.logAttributes());
    try {
      return await next(input);
    } catch (err: any) {
      error = err;
      throw err;
    } finally {
      const durationNanos = process.hrtime.bigint() - startTime;
      const durationMs = Number(durationNanos / 1_000_000n);
      if (error === UNINITIAILIZED) {
        this.logger.debug('Activity completed', { durationMs, ...this.logAttributes() });
        return;
      }
      // Avoid using instanceof checks in case the modules they're defined in loaded more than once,
      // e.g. by jest or when multiple versions are installed.
      if (typeof error === 'object' && error != null) {
        if (error.name === 'CancelledFailure' && this.ctx.cancellationSignal.aborted) {
          this.logger.debug('Activity completed as cancelled', { durationMs, ...this.logAttributes() });
          return;
        } else if (error.name === 'CompleteAsyncError') {
          this.logger.debug('Activity will complete asynchronously', { durationMs, ...this.logAttributes() });
          return;
        }
      }
      this.logger.warn('Activity failed', { error, durationMs, ...this.logAttributes() });
    }
  }
}
