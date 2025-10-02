import { formatWithOptions } from 'node:util';
import * as supportsColor from 'supports-color';
import { native } from '@temporalio/core-bridge';
import { LogLevel, LogMetadata, Logger } from '@temporalio/common';

/** @deprecated Import from @temporalio/common instead */
export { LogLevel, LogMetadata, Logger };

export interface LogEntry {
  /**
   * Log message
   */
  message: string;

  /**
   * Log level
   */
  level: LogLevel;

  /**
   * Time since epoch, in nanoseconds.
   */
  timestampNanos: bigint;

  /**
   * Custom attributes
   */
  meta?: LogMetadata;
}

export const LogTimestamp = Symbol.for('log_timestamp');

const severities: LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];

/**
 * @internal
 */
const loggerHasColorsSymbol = Symbol.for('logger_has_colors');
const stderrHasColors = !!supportsColor.stderr;
const format = formatWithOptions.bind(undefined, { colors: stderrHasColors });

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
    (this as LoggerWithColorSupport)[loggerHasColorsSymbol] =
      (logFunction === defaultLogFunction && stderrHasColors) ?? false;
  }

  log(level: LogLevel, message: string, meta?: LogMetadata): void {
    if (severities.indexOf(level) >= this.severity) {
      const { [LogTimestamp]: timestampNanos, ...rest } = meta ?? {};
      this.logFunction({
        level,
        message,
        meta: Object.keys(rest).length === 0 ? undefined : rest,
        timestampNanos: timestampNanos ?? native.getTimeOfDay(),
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

/**
 * @internal
 */
interface LoggerWithColorSupport extends Logger {
  [loggerHasColorsSymbol]?: boolean;
}

/**
 * @internal
 */
export function hasColorSupport(logger: Logger): boolean {
  return (logger as LoggerWithColorSupport)[loggerHasColorsSymbol] ?? false;
}

export interface FlushableLogger extends Logger {
  flush(): void;
  close?(): void;
}

export function isFlushableLogger(logger: Logger): logger is FlushableLogger {
  return 'flush' in logger && typeof logger.flush === 'function';
}
