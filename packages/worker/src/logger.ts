import { formatWithOptions } from 'node:util';
import * as supportsColor from 'supports-color';
import { native } from '@temporalio/core-bridge';
import { LogLevel, LogMetadata, Logger } from '@temporalio/common';
import { mergeObjects, filterNullAndUndefined } from '@temporalio/common/lib/internal-workflow';

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

export interface FlushableLogger extends Logger {
  flush(): void;
}

export function isFlushableLogger(logger: Logger): logger is FlushableLogger {
  return 'flush' in logger && typeof logger.flush === 'function';
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
export function hasColorSupport(logger: Logger): boolean {
  return (logger as LoggerWithColorSupport)[loggerHasColorsSymbol] ?? false;
}

export type LogMetaOrFunc = LogMetadata | (() => LogMetadata);

export class LoggerWithComposedMetadata implements Logger {
  /**
   * Return a Logger that adds metadata before delegating calls to a parent logger.
   *
   * New logs may either be specified statically as a delta object, or as a function
   * evaluated every time a log is emitted that will return a delta object.
   *
   * Performs various optimizations to avoid creating unnecessary objects and to
   * keep runtime overhead associated with resolving metadata as low as possible.
   */
  public static compose(logger: Logger, metaOrFunc: LogMetaOrFunc): Logger {
    // Flatten recusive LoggerWithComposedMetadata instances
    if (logger instanceof LoggerWithComposedMetadata) {
      const contributors = appendToChain(logger.contributors, metaOrFunc);
      // If the new contributor results in no actual change to the chain, then we don't need a new logger
      if (contributors === undefined) return logger;
      return new LoggerWithComposedMetadata(logger.parentLogger, contributors);
    } else {
      const contributors = appendToChain(undefined, metaOrFunc);
      if (contributors === undefined) return logger;
      return new LoggerWithComposedMetadata(logger, contributors);
    }
  }

  constructor(
    private readonly parentLogger: Logger,
    private readonly contributors: LogMetaOrFunc[]
  ) {
    (this as LoggerWithColorSupport)[loggerHasColorsSymbol] = hasColorSupport(parentLogger);
  }

  log(level: LogLevel, message: string, extraMeta?: LogMetadata): void {
    this.parentLogger.log(level, message, resolveMetadata(this.contributors, extraMeta));
  }

  trace(message: string, extraMeta?: LogMetadata): void {
    this.parentLogger.trace(message, resolveMetadata(this.contributors, extraMeta));
  }

  debug(message: string, extraMeta?: LogMetadata): void {
    this.parentLogger.debug(message, resolveMetadata(this.contributors, extraMeta));
  }

  info(message: string, extraMeta?: LogMetadata): void {
    this.parentLogger.info(message, resolveMetadata(this.contributors, extraMeta));
  }

  warn(message: string, extraMeta?: LogMetadata): void {
    this.parentLogger.warn(message, resolveMetadata(this.contributors, extraMeta));
  }

  error(message: string, extraMeta?: LogMetadata): void {
    this.parentLogger.error(message, resolveMetadata(this.contributors, extraMeta));
  }
}

function resolveMetadata(contributors: LogMetaOrFunc[], extraMeta?: LogMetadata): LogMetadata {
  const resolved = {};
  for (const contributor of contributors) {
    Object.assign(resolved, typeof contributor === 'function' ? contributor() : contributor);
  }
  Object.assign(resolved, extraMeta);
  return filterNullAndUndefined(resolved);
}

/**
 * Append a metadata contributor to the chain, merging it with the former last contributor if both are plain objects
 */
function appendToChain(
  existingContributors: LogMetaOrFunc[] | undefined,
  newContributor: LogMetaOrFunc
): LogMetaOrFunc[] | undefined {
  // If the new contributor is an empty object, then it results in no actual change to the chain
  if (typeof newContributor === 'object' && Object.keys(newContributor).length === 0) {
    return existingContributors;
  }

  // If existing chain is empty, then the new contributor is the chain
  if (existingContributors == null || existingContributors.length === 0) {
    return [newContributor];
  }

  // If both last contributor and new contributor are plain objects, merge them to a single object.
  const last = existingContributors[existingContributors.length - 1];
  if (typeof last === 'object' && typeof newContributor === 'object') {
    const merged = mergeObjects(last, newContributor);
    if (merged === last) return existingContributors;
    return [...existingContributors.slice(0, -1), merged];
  }

  // Otherwise, just append the new contributor to the chain.
  return [...existingContributors, newContributor];
}
