import { type LoggerSinksInternal } from '@temporalio/workflow/lib/logs';
import { SdkComponent } from '@temporalio/common';
import { LoggerWithComposedMetadata } from '@temporalio/common/lib/logger';
import { type InjectedSinks } from '../sinks';
import { type Logger } from '../logger';

/**
 * Injects a logger sink that forwards to the worker's logger
 */
export function initLoggerSink(logger: Logger): InjectedSinks<LoggerSinksInternal> {
  logger = LoggerWithComposedMetadata.compose(logger, { sdkComponent: SdkComponent.workflow });
  return {
    __temporal_logger: {
      trace: {
        fn(_, message, attrs) {
          logger.trace(message, attrs);
        },
      },
      debug: {
        fn(_, message, attrs) {
          logger.debug(message, attrs);
        },
      },
      info: {
        fn(_, message, attrs) {
          logger.info(message, attrs);
        },
      },
      warn: {
        fn(_, message, attrs) {
          logger.warn(message, attrs);
        },
      },
      error: {
        fn(_, message, attrs) {
          logger.error(message, attrs);
        },
      },
    },
  };
}
