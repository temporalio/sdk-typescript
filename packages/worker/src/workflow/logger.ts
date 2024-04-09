import { type LoggerSinksInternal } from '@temporalio/workflow/lib/logs';
import { type InjectedSinks } from '../sinks';
import { Runtime } from '../runtime';
import { withMetadata, type Logger } from '../logger';

/**
 * Injects a logger sink that forwards to the worker's logger
 */
export function initLoggerSink(logger?: Logger): InjectedSinks<LoggerSinksInternal> {
  return {
    __temporal_logger: {
      trace: {
        fn(_, message, attrs) {
          logger ??= withMetadata(Runtime.instance().logger);
          logger.trace(message, attrs);
        },
      },
      debug: {
        fn(_, message, attrs) {
          logger ??= Runtime.instance().logger;
          logger.debug(message, attrs);
        },
      },
      info: {
        fn(_, message, attrs) {
          logger ??= Runtime.instance().logger;
          logger.info(message, attrs);
        },
      },
      warn: {
        fn(_, message, attrs) {
          logger ??= Runtime.instance().logger;
          logger.warn(message, attrs);
        },
      },
      error: {
        fn(_, message, attrs) {
          logger ??= Runtime.instance().logger;
          logger.error(message, attrs);
        },
      },
    },
  };
}
