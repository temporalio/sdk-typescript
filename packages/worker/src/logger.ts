import { writeSync } from 'node:fs';
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
  process.stderr.write(formatLogEntry(entry));
}

function formatLogEntry({ level, timestampNanos, message, meta }: LogEntry): string {
  const date = new Date(Number(timestampNanos / 1_000_000n));
  return meta === undefined
    ? `${format(date)} [${level}] ${message}\n`
    : `${format(date)} [${level}] ${message} ${format(meta)}\n`;
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
        timestampNanos: typeof timestampNanos === 'bigint' ? timestampNanos : native.getTimeOfDay(),
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

/**
 * A logger that may opt-in to receive flush requests.
 *
 * This is the interface expected by {@link RuntimeOptions.logger}. Unlike the {@link Logger}
 * exposed by Workflow and Activity contexts, this interface supports an optional flush hook.
 * If the the `flush()` method exists, then it may be called by the SDK in some situations
 * where it may be desirable to immediately flush buffered log messages (e.g. when a Worker
 * or Runtime terminates).
 *
 * @experimental
 */
export interface FlushableLogger extends Logger {
  /**
   * Flush buffered log entries synchronously.
   *
   * This hook may be called repeatedly, including when there are no new entries.
   * It must leave the logger usable.
   */
  flush?(): void;
}

/**
 * Keep synchronous application logger failures out of SDK control flow.
 *
 * @internal
 */
export class NonThrowingLogger implements FlushableLogger {
  // Avoid stream errors escaping asynchronously from this last-resort output path.
  private static readonly stderrFallback = new DefaultLogger('WARN', (entry) => writeSync(2, formatLogEntry(entry)));

  readonly [loggerHasColorsSymbol]: boolean;

  constructor(private readonly logger: FlushableLogger) {
    this[loggerHasColorsSymbol] = hasColorSupport(logger);
  }

  log(level: LogLevel, message: string, meta?: LogMetadata): void {
    try {
      this.logger.log(level, message, meta);
    } catch {
      this.onLoggerFailure(level, message, meta);
    }
  }

  trace(message: string, meta?: LogMetadata): void {
    try {
      this.logger.trace(message, meta);
    } catch {
      this.onLoggerFailure('TRACE', message, meta);
    }
  }

  debug(message: string, meta?: LogMetadata): void {
    try {
      this.logger.debug(message, meta);
    } catch {
      this.onLoggerFailure('DEBUG', message, meta);
    }
  }

  info(message: string, meta?: LogMetadata): void {
    try {
      this.logger.info(message, meta);
    } catch {
      this.onLoggerFailure('INFO', message, meta);
    }
  }

  warn(message: string, meta?: LogMetadata): void {
    try {
      this.logger.warn(message, meta);
    } catch {
      this.onLoggerFailure('WARN', message, meta);
    }
  }

  error(message: string, meta?: LogMetadata): void {
    try {
      this.logger.error(message, meta);
    } catch {
      this.onLoggerFailure('ERROR', message, meta);
    }
  }

  flush(): void {
    try {
      this.logger.flush?.();
    } catch (error) {
      this.onLoggerFailure('ERROR', 'Failed to flush logs', { error });
    }
  }

  private onLoggerFailure(level: LogLevel, message: string, meta?: LogMetadata): void {
    try {
      // Only WARN and ERROR reach stderr; see `stderrFallback`'s level.
      NonThrowingLogger.stderrFallback.log(level, message, meta);
    } catch {
      // Neither formatting nor stderr failures may affect SDK control flow.
    }
  }
}
