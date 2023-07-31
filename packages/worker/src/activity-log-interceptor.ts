import { CompleteAsyncError, Context, Info } from '@temporalio/activity';
import { CancelledFailure } from '@temporalio/common';
import { isAbortError } from '@temporalio/common/lib/type-helpers';
import { ActivityInboundCallsInterceptor, ActivityExecuteInput, Next } from './interceptors';
import { Logger } from './logger';

const UNINITIALIZED = Symbol('UNINITIALIZED');

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
  /**
   * @deprecated Use `Context.current().logger` instead
   */
  protected readonly logger: Logger;

  constructor(protected readonly ctx: Context, logger?: Logger | undefined) {
    // If a parent logger was explicitly provided on this interceptor, then use it.
    // Otherwise, use the logger that is already set on the activity context.
    // By default, that will be Runtime.logger, but another interceptor might have overriden it,
    // in which case we would want to use that one as our parent logger.
    const parentLogger = logger ?? ctx.log;
    this.logger = parentLogger; // eslint-disable-line deprecation/deprecation

    this.ctx.log = Object.fromEntries(
      (['trace', 'debug', 'info', 'warn', 'error'] as const).map((level) => {
        return [
          level,
          (message: string, attrs: Record<string, unknown>) => {
            return parentLogger[level](message, {
              ...this.logAttributes(),
              ...attrs,
            });
          },
        ];
      })
    ) as any;
  }

  protected logAttributes(): Record<string, unknown> {
    return activityLogAttributes(this.ctx.info);
  }

  async execute(input: ActivityExecuteInput, next: Next<ActivityInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    let error: any = UNINITIALIZED; // In case someone decides to throw undefined...
    const startTime = process.hrtime.bigint();
    this.ctx.log.debug('Activity started');
    try {
      return await next(input);
    } catch (err: any) {
      error = err;
      throw err;
    } finally {
      const durationNanos = process.hrtime.bigint() - startTime;
      const durationMs = Number(durationNanos / 1_000_000n);

      if (error === UNINITIALIZED) {
        this.ctx.log.debug('Activity completed', { durationMs });
      } else if ((error instanceof CancelledFailure || isAbortError(error)) && this.ctx.cancellationSignal.aborted) {
        this.ctx.log.debug('Activity completed as cancelled', { durationMs });
      } else if (error instanceof CompleteAsyncError) {
        this.ctx.log.debug('Activity will complete asynchronously', { durationMs });
      } else {
        this.ctx.log.warn('Activity failed', { error, durationMs });
      }
    }
  }
}
