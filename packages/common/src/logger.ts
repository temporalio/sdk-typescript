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
 * Possible values of the `logSource` meta attributes on log messages. This
 * attribute indicates which subsystem emitted the log message; this may for
 * example be used to implement fine-grained filtering of log messages.
 *
 * Note that there is no guarantee that this list will remain stable in the
 * future; values may be added or removed, and messages that are currently
 * emitted with some `logSource` value may use a different value in the future.
 */
export enum LogSource {
  /**
   * Log Source value for messages emited from Workflow code, using the {@link Workflow
   * context logger|workflow.log}. The SDK itself never publishes messages with this source.
   */
  workflow = 'workflow',

  /**
   * Log Source value for messages emited from an activity, using the {@link activity
   * context logger|Context.log}. The SDK itself never publishes messages with this source.
   */
  activity = 'activity',

  /**
   * Log Source value for messages emited from a Temporal Worker instance.
   *
   * This notably includes:
   * - Issues with worker or runtime options or the JS execution environment;
   * - Worker's, Activity's, and Workflow's lifecycle events;
   * - Workflow Activation and Activity Task processing events;
   * - Workflow Bundling messages;
   * - Sink processing issues;
   * - Issues in interracting with the Core SDK library.
   */
  worker = 'worker',

  /**
   * Log Source value for all messages emited by the Core SDK library.
   */
  core = 'core',
}
