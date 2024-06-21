import { formatWithOptions } from 'node:util';
import * as supportsColor from 'supports-color';
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

/**
 * @internal
 */
interface LoggerWithColorSupport extends Logger {
  [loggerHasColorsSymbol]?: boolean;
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

/**
 * @internal
 */
export function hasColorSupport(logger: Logger): boolean {
  return (logger as LoggerWithColorSupport)[loggerHasColorsSymbol] ?? false;
}

export function withMetadata(logger: Logger, meta: LogMetadata | (() => LogMetadata)): Logger {
  return new LoggerWithMetadata(logger, meta);
}

class LoggerWithMetadata implements Logger {
  private parentLogger: Logger;
  private metaChain: (LogMetadata | (() => LogMetadata))[];

  constructor(parent: Logger, meta: LogMetadata | (() => LogMetadata)) {
    // Flatten recusive LoggerWithMetadata instances
    if (parent instanceof LoggerWithMetadata) {
      this.parentLogger = parent.parentLogger;
      this.metaChain = LoggerWithMetadata.appendToChain(parent.metaChain, meta);
    } else {
      this.parentLogger = parent;
      this.metaChain = [meta];
    }
    (this as LoggerWithColorSupport)[loggerHasColorsSymbol] = hasColorSupport(parent);
  }

  log(level: LogLevel, message: string, meta?: LogMetadata): void {
    this.parentLogger.log(level, message, this.resolveMetadata(meta));
  }

  trace(message: string, meta?: LogMetadata): void {
    this.parentLogger.trace(message, this.resolveMetadata(meta));
  }

  debug(message: string, meta?: LogMetadata): void {
    this.parentLogger.debug(message, this.resolveMetadata(meta));
  }

  info(message: string, meta?: LogMetadata): void {
    this.parentLogger.info(message, this.resolveMetadata(meta));
  }

  warn(message: string, meta?: LogMetadata): void {
    this.parentLogger.warn(message, this.resolveMetadata(meta));
  }

  error(message: string, meta?: LogMetadata): void {
    this.parentLogger.error(message, this.resolveMetadata(meta));
  }

  private resolveMetadata(meta?: LogMetadata): LogMetadata {
    const resolved = {};
    for (const contributor of this.metaChain) {
      Object.assign(resolved, typeof contributor === 'function' ? contributor() : contributor);
    }
    Object.assign(resolved, meta);
    return resolved;
  }

  /**
   * Append a metadata contributor to the chain, merging it with the former last contributor if both are plain objects
   */
  private static appendToChain(chain: (LogMetadata | (() => LogMetadata))[], meta: LogMetadata | (() => LogMetadata)) {
    if (chain.length === 0) return [meta];
    const last = chain[chain.length - 1];
    if (typeof last === 'object' && typeof meta === 'object') {
      return [...chain.slice(0, -1), { ...last, ...meta }];
    }
    return [...chain, meta];
  }
}
