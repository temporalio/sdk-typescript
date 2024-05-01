import { Context } from '@temporalio/activity';
import { SdkComponent } from '@temporalio/common';
import { ActivityInboundCallsInterceptor, ActivityExecuteInput, Next } from './interceptors';
import { Logger } from './logger';
import { activityLogAttributes } from './activity';
import { Runtime } from './runtime';

/**
 * This interceptor was previously used to log Activity execution starts and their completions. It is now deprecated
 * and behaves as a noop in most cases. It is only kept arround to avoid breaking code out there that was previously
 * refering to it.
 *
 * @deprecated `ActivityInboundLogInterceptor` is deprecated. Activity lifecycle events are now automatically logged
 *             by the SDK. To customize activity log attributes, register a custom {@link ActivityOutboundCallsInterceptor}
 *             that intercepts the `getLogAttributes()` method. To customize where log messages are sent, set the
 *             {@link Runtime.logger} property.
 */
export class ActivityInboundLogInterceptor implements ActivityInboundCallsInterceptor {
  protected readonly logger: Logger;

  constructor(
    protected readonly ctx: Context,
    logger?: Logger | undefined
  ) {
    const runtimeLogger = Runtime.instance().logger;
    this.logger = logger ?? runtimeLogger;

    // In the very common case where `ActivityInboundLogInterceptor` is intantiated without a custom logger and without
    // extending it (ie. to inject custom log attributes), then just be a noop. This is just to avoid bothering users
    // that followed something that used to be a recommended pattern. The "default" behavior that used to be provided by
    // this class is now handled elsewhere.
    if (
      this.logger === runtimeLogger &&
      Object.getPrototypeOf(this) === ActivityInboundLogInterceptor.prototype // eslint-disable-line deprecation/deprecation
    )
      return;

    this.ctx.log = Object.fromEntries(
      (['trace', 'debug', 'info', 'warn', 'error'] as const).map((level) => {
        return [
          level,
          (message: string, attrs: Record<string, unknown>) => {
            return this.logger[level](message, {
              sdkComponent: SdkComponent.activity,
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
    // Logging of activity's lifecycle events is now handled in `worker/src/activity.ts`
    return next(input);
  }
}
