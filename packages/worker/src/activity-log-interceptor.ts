import { CompleteAsyncError, Context } from '@temporalio/activity';
import { CancelledFailure } from '@temporalio/common';
import { isAbortError } from '@temporalio/common/lib/type-helpers';
import { ActivityInboundCallsInterceptor, ActivityExecuteInput, Next } from './interceptors';
import { Logger } from './logger';
import { activityLogAttributes } from './activity';
import { Runtime } from './runtime';

const UNINITIALIZED = Symbol('UNINITIALIZED');

/**
 * Logs Activity execution starts and their completions
 *
 * @deprecated `ActivityInboundLogInterceptor` is deprecated. To customize activity log attributes,
 *             simply register a custom `WorkflowInterceptors` that intercepts the
 *             `outbound.getLogAttributes()` method. To customize where log messages are sent,
 *             set the {@see Runtime.logger} property.
 */
export class ActivityInboundLogInterceptor implements ActivityInboundCallsInterceptor {
  protected readonly logger: Logger;

  constructor(protected readonly ctx: Context, logger?: Logger | undefined) {
    const runtimeLogger = Runtime.instance().logger;
    this.logger = logger ?? runtimeLogger; // eslint-disable-line deprecation/deprecation

    // In the very common case where `ActivityInboundLogInterceptor` is intantiated without a custom logger and without
    // extending it (ie. to inject custom log attributes), then just be a noop. This is just to avoid bothering users
    // that followed something that used to be a recommended pattern. The "default" behavior that used to be provided by
    // this class is now handled in `worker/src/activity.ts`.
    if (
      (!logger || logger === Runtime.instance().logger) &&
      // eslint-disable-next-line deprecation/deprecation
      Object.getPrototypeOf(this) === ActivityInboundLogInterceptor.prototype
    )
      return;

    // If a logger was explicitly provided on this interceptor, then use it.
    // Note that injecting a logger this way is deprecated.
    this.ctx.log = Object.fromEntries(
      (['trace', 'debug', 'info', 'warn', 'error'] as const).map((level) => {
        return [
          level,
          (message: string, attrs: Record<string, unknown>) => {
            return this.logger[level](message, {
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
