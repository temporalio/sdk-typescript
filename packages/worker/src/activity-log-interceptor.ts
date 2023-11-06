import { Context } from '@temporalio/activity';
import { ActivityInboundCallsInterceptor, ActivityExecuteInput, Next } from './interceptors';
import { Logger } from './logger';
import { activityLogAttributes } from './activity';
import { Runtime } from './runtime';

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
    // Logging of activity's life cycle events is now handled in `worker/src/activity.ts`
    // This interceptor is now a noop in most cases, except for legacy support of some deprecated usage.
    return next(input);
  }
}
