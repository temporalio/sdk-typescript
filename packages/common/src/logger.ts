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
 * Log Sources are organized as a hierarchy, separated by forward slashes.
 * The values enumerated here should be considered as prefixes, as some
 * descendants may exist that are not enumerated here. Also, there is no
 * guarantee that this list will remain stable in the future.
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
   * This includes:
   * - Issues with worker options;
   * - Worker's lifecycle events.
   */
  worker = 'worker',

  /**
   * Log Source value for messages emited from an Activity Worker.
   * This includes:
   * - Activity Lifecycle events;
   * - Activity Task processing events;
   * - Activity Worker's lifecycle events.
   */
  activityWorker = 'worker/activity',

  /**
   * Log Source value for messages emited from a Workflow Worker.
   * This includes:
   * - Workflow Lifecycle events;
   * - Workflow Activations processing events;
   * - Sink processing issues;
   * - Workflow Worker's lifecycle events.
   */
  workflowWorker = 'worker/workflow',

  /**
   * Log Source value for messages emited by the Workflow Bundling process,
   * when being executed implicitly by the Workflow Worker.
   */
  workflowBundler = 'worker/bundler',

  /**
   * Log Source value for messages emited by the Temporal SDK Runtime.
   * This includes:
   * - Issues with the JS execution environment;
   * - Issues in interracting with the Core SDK library.
   */
  runtime = 'runtime',

  /**
   * Log Source prefix for all messages emited by the Core SDK library.
   */
  core = 'core',

  /**
   * Log Source prefix for messages emited by the Core SDK's Native Client subsystem.
   */
  coreClient = 'core/client',

  /**
   * Log Source prefix for messages emited by the Core SDK's Worker subsystem.
   */
  coreWorker = 'core/worker',
}
