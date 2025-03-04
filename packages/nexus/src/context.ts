import { HandlerContext as BaseHandlerContext, getHandlerContext } from 'nexus-rpc/lib/handler';
import { Logger, LogLevel, LogMetadata } from '@temporalio/common';

export interface HandlerContext extends BaseHandlerContext {
  log: Logger;
}

function getLogger() {
  const ctx = getHandlerContext<HandlerContext>();
  if (ctx == null) {
    throw new ReferenceError('HandlerContext uninitialized');
  }
  return ctx.log;
}

/**
 * A logger for use in Nexus Handler scope.
 */
export const log: Logger = {
  log(level: LogLevel, message: string, meta?: LogMetadata): any {
    return getLogger().log(level, message, meta);
  },
  trace(message: string, meta?: LogMetadata): any {
    return getLogger().trace(message, meta);
  },
  debug(message: string, meta?: LogMetadata): any {
    return getLogger().debug(message, meta);
  },
  info(message: string, meta?: LogMetadata): any {
    return getLogger().info(message, meta);
  },
  warn(message: string, meta?: LogMetadata): any {
    return getLogger().warn(message, meta);
  },
  error(message: string, meta?: LogMetadata): any {
    return getLogger().error(message, meta);
  },
};
