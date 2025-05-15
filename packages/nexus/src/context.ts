import { HandlerContext as BaseHandlerContext, getHandlerContext } from 'nexus-rpc/lib/handler';
import { Logger, LogLevel, LogMetadata } from '@temporalio/common';
import { Client } from '@temporalio/client';

export interface HandlerContext extends BaseHandlerContext {
  log: Logger;
  client: Client;
}

function getLogger() {
  return getHandlerContext<HandlerContext>().log;
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

/**
 * Returns a client to be used in a Nexus Operation's context, this Client is powered by the same Connection that the
 * worker was created with.
 */
export function getClient(): Client {
  return getHandlerContext<HandlerContext>().client;
}

// TODO: also support getting a metrics handler.
