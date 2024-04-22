import { formatWithOptions } from 'node:util';
import { getTimeOfDay } from '@temporalio/core-bridge';
import { LogLevel, LogMetadata, Logger } from '@temporalio/common';

/** @deprecated Import from @temporalio/common instead */
export { LogLevel, LogMetadata, Logger };

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestampNanos: bigint;
  /** Custom attributes */
  meta?: LogMetadata;
}

export const LogTimestamp = Symbol.for('log_timestamp');

const severities: LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];

const format = formatWithOptions.bind(undefined, { colors: true });

/**
 * Log messages to `stderr` using basic formatting
 */
function defaultLogFunction(entry: LogEntry): void {
  const { level, timestampNanos, message, meta } = entry;

  const date = new Date(Number(timestampNanos / 1_000_000n));
  if (meta === undefined) {
    process.stderr.write(`${format(date)} [${level}] ${message}\n`);
  } else {
    process.stderr.write(`${format(date)} [${level}] ${message} ${format(meta)}\n`);
  }
}

/**
 * Takes a `[seconds, nanos]` tuple as returned from getTimeOfDay and turns it into bigint.
 */
export function timeOfDayToBigint(timeOfDay: [number, number]): bigint {
  const [seconds, nanos] = timeOfDay;
  return BigInt(seconds) * 1_000_000_000n + BigInt(nanos);
}

/**
 * Default worker logger - uses a default log function to log messages to `console.error`.
 * See constructor arguments for customization.
 */
export class DefaultLogger implements Logger {
  protected readonly severity: number;

  constructor(
    public readonly level: LogLevel = 'INFO',
    protected readonly logFunction = defaultLogFunction
  ) {
    this.severity = severities.indexOf(this.level);
  }

  log(level: LogLevel, message: string, meta?: LogMetadata): void {
    if (severities.indexOf(level) >= this.severity) {
      const { [LogTimestamp]: timestampNanos, ...rest } = meta ?? {};
      this.logFunction({
        level,
        message,
        meta: Object.keys(rest).length === 0 ? undefined : rest,
        timestampNanos: timestampNanos ?? timeOfDayToBigint(getTimeOfDay()),
      });
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

export function withMetadata(logger: Logger, meta: LogMetadata): Logger {
  return new LoggerWithMetadata(logger, meta);
}

class LoggerWithMetadata implements Logger {
  constructor(
    public readonly logger: Logger,
    public readonly meta: LogMetadata
  ) {}

  log(level: LogLevel, message: string, meta?: LogMetadata): void {
    this.logger.log(level, message, { ...this.meta, ...meta });
  }

  trace(message: string, meta?: LogMetadata): void {
    this.logger.trace(message, { ...this.meta, ...meta });
  }

  debug(message: string, meta?: LogMetadata): void {
    this.logger.debug(message, { ...this.meta, ...meta });
  }

  info(message: string, meta?: LogMetadata): void {
    this.logger.info(message, { ...this.meta, ...meta });
  }

  warn(message: string, meta?: LogMetadata): void {
    this.logger.warn(message, { ...this.meta, ...meta });
  }

  error(message: string, meta?: LogMetadata): void {
    this.logger.error(message, { ...this.meta, ...meta });
  }
}
