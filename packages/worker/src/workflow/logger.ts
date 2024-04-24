import { type LoggerSinksInternal } from '@temporalio/workflow/lib/logs';
import { LogSource } from '@temporalio/common';
import { type InjectedSinks } from '../sinks';
import { type Logger } from '../logger';

/**
 * Injects a logger sink that forwards to the worker's logger
 */
export function initLoggerSink(logger: Logger): InjectedSinks<LoggerSinksInternal> {
  return {
    __temporal_logger: {
      trace: {
        fn(_, message, attrs) {
          logger.trace(message, { logSource: LogSource.workflow, ...attrs });
        },
      },
      debug: {
        fn(_, message, attrs) {
          logger.debug(message, { logSource: LogSource.workflow, ...attrs });
        },
      },
      info: {
        fn(_, message, attrs) {
          logger.info(message, { logSource: LogSource.workflow, ...attrs });
        },
      },
      warn: {
        fn(_, message, attrs) {
          logger.warn(message, { logSource: LogSource.workflow, ...attrs });
        },
      },
      error: {
        fn(_, message, attrs) {
          logger.error(message, { logSource: LogSource.workflow, ...attrs });
        },
      },
    },
  };
}
