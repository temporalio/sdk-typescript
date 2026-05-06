import type { Logger } from '@temporalio/worker';
import { PowertoolsLoggerAdapter } from './json-logger';

/**
 * Create a Powertools-based logger for the Lambda worker.
 *
 * If `@aws-lambda-powertools/logger` is installed, returns a
 * {@link PowertoolsLoggerAdapter} wrapping a Powertools Logger.
 * Otherwise, returns `undefined`, causing the Runtime to fall back
 * to its default logger.
 */
export function makePowertoolsLogger(): Logger | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Logger: PtLogger } = require('@aws-lambda-powertools/logger');
    return new PowertoolsLoggerAdapter(
      new PtLogger({
        serviceName: process.env['AWS_LAMBDA_FUNCTION_NAME'] ?? 'temporal-lambda-worker',
      })
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') {
      throw err;
    }
    return undefined;
  }
}
