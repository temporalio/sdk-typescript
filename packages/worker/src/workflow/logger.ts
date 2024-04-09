import { type LoggerSinksInternal } from '@temporalio/workflow/lib/logs';
import { LogSource } from '@temporalio/common';
import { type InjectedSinks } from '../sinks';
import { withMetadata, type Logger } from '../logger';

/**
 * Injects a logger sink that forwards to the worker's logger
 */
export function initLoggerSink(logger: Logger): InjectedSinks<LoggerSinksInternal> {
  const loggerWithMetadata = withMetadata(logger, { logSource: LogSource.workflow });
  return {
    __temporal_logger: {
      trace: {
        fn(_, message, attrs) {
          loggerWithMetadata.trace(message, attrs);
        },
      },
      debug: {
        fn(_, message, attrs) {
          loggerWithMetadata.debug(message, attrs);
        },
      },
      info: {
        fn(_, message, attrs) {
          loggerWithMetadata.info(message, attrs);
        },
      },
      warn: {
        fn(_, message, attrs) {
          loggerWithMetadata.warn(message, attrs);
        },
      },
      error: {
        fn(_, message, attrs) {
          loggerWithMetadata.error(message, attrs);
        },
      },
    },
  };
}
