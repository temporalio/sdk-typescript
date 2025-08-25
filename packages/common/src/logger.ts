import { filterNullAndUndefined, mergeObjects } from './internal-workflow';

export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export type LogMetadata = Record<string | symbol, any>;

/**
 * Implement this interface in order to customize worker logging
 */
export interface Logger {
  log(level: LogLevel, message: string, meta?: LogMetadata): any;
  trace(message: string, meta?: LogMetadata): any;
  debug(message: string, meta?: LogMetadata): any;
  info(message: string, meta?: LogMetadata): any;
  warn(message: string, meta?: LogMetadata): any;
  error(message: string, meta?: LogMetadata): any;
}

/**
 * Possible values of the `sdkComponent` meta attributes on log messages. This
 * attribute indicates which subsystem emitted the log message; this may for
 * example be used to implement fine-grained filtering of log messages.
 *
 * Note that there is no guarantee that this list will remain stable in the
 * future; values may be added or removed, and messages that are currently
 * emitted with some `sdkComponent` value may use a different value in the future.
 */
export enum SdkComponent {
  /**
   * Component name for messages emited from Workflow code, using the {@link Workflow context logger|workflow.log}.
   * The SDK itself never publishes messages with this component name.
   */
  workflow = 'workflow',

  /**
   * Component name for messages emited from an activity, using the {@link activity context logger|Context.log}.
   * The SDK itself never publishes messages with this component name.
   */
  activity = 'activity',

  /**
   * Component name for messages emited from a Nexus Operation Handler, using the Nexus context logger.
   * The SDK itself never publishes messages with this component name.
   */
  nexus = 'nexus',

  /**
   * Component name for messages emited from a Temporal Worker instance.
   *
   * This notably includes:
   * - Issues with Worker or runtime configuration, or the JS execution environment;
   * - Worker's, Activity's, and Workflow's lifecycle events;
   * - Workflow Activation and Activity Task processing events;
   * - Workflow bundling messages;
   * - Sink processing issues.
   */
  worker = 'worker',

  /**
   * Component name for all messages emitted by the Rust Core SDK library.
   */
  core = 'core',
}

////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * @internal
 * @hidden
 */
export type LogMetaOrFunc = LogMetadata | (() => LogMetadata);

/**
 * A logger implementation that adds metadata before delegating calls to a parent logger.
 *
 * @internal
 * @hidden
 */
export class LoggerWithComposedMetadata implements Logger {
  /**
   * Return a {@link Logger} that adds metadata before delegating calls to a parent logger.
   *
   * New metadata may either be specified statically as a delta object, or as a function evaluated
   * every time a log is emitted that will return a delta object.
   *
   * Some optimizations are performed to avoid creating unnecessary objects and to keep runtime
   * overhead associated with resolving metadata as low as possible.
   */
  public static compose(logger: Logger, metaOrFunc: LogMetaOrFunc): Logger {
    // Flatten recursive LoggerWithComposedMetadata instances
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
  ) {}

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
