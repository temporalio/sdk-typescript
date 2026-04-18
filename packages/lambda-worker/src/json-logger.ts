import type { Logger as PowertoolsLogger } from '@aws-lambda-powertools/logger';
import type { Context } from 'aws-lambda';
import type { LogLevel, LogMetadata } from '@temporalio/common';
import type { Logger } from '@temporalio/worker';

/**
 * Adapter that wraps an AWS Lambda Powertools Logger to implement the Temporal SDK Logger interface.
 *
 * This is used as the default logger for the Lambda worker, producing structured JSON output
 * that CloudWatch Logs automatically parses.
 *
 * @example
 * ```ts
 * import { Logger } from '@aws-lambda-powertools/logger';
 * import { PowertoolsLoggerAdapter } from '@temporalio/lambda-worker';
 *
 * const adapter = new PowertoolsLoggerAdapter(new Logger({ serviceName: 'my-worker' }));
 * ```
 */
export class PowertoolsLoggerAdapter implements Logger {
  constructor(private readonly ptLogger: PowertoolsLogger) {}

  addContext(context: Context): void {
    this.ptLogger.addContext(context);
  }

  log(level: LogLevel, message: string, meta?: LogMetadata): void {
    switch (level) {
      case 'TRACE':
        this.ptLogger.debug(message, { ...meta, traceLevel: true });
        break;
      case 'DEBUG':
        this.ptLogger.debug(message, meta as Record<string, unknown>);
        break;
      case 'INFO':
        this.ptLogger.info(message, meta as Record<string, unknown>);
        break;
      case 'WARN':
        this.ptLogger.warn(message, meta as Record<string, unknown>);
        break;
      case 'ERROR':
        this.ptLogger.error(message, meta as Record<string, unknown>);
        break;
      default:
        level satisfies never;
        break;
    }
  }

  trace(message: string, meta?: LogMetadata): void {
    this.log('TRACE', message, meta);
  }

  debug(message: string, meta?: LogMetadata): void {
    this.log('DEBUG', message, meta);
  }

  info(message: string, meta?: LogMetadata): void {
    this.log('INFO', message, meta);
  }

  warn(message: string, meta?: LogMetadata): void {
    this.log('WARN', message, meta);
  }

  error(message: string, meta?: LogMetadata): void {
    this.log('ERROR', message, meta);
  }
}
