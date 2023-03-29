import * as os from 'node:os';
import * as v8 from 'node:v8';
import type { Configuration as WebpackConfiguration } from 'webpack';
import { DataConverter, LoadedDataConverter } from '@temporalio/common';
import { msOptionalToNumber, msToNumber } from '@temporalio/common/lib/time';
import { loadDataConverter } from '@temporalio/common/lib/internal-non-workflow';
import { LoggerSinks } from '@temporalio/workflow';
import { ActivityInboundLogInterceptor } from './activity-log-interceptor';
import { NativeConnection } from './connection';
import { WorkerInterceptors } from './interceptors';
import { Runtime } from './runtime';
import { InjectedSinks } from './sinks';
import { GiB } from './utils';
import { defaultWorflowInterceptorModules, WorkflowBundleWithSourceMap } from './workflow/bundler';

export type { WebpackConfiguration };

export interface WorkflowBundlePath {
  codePath: string;
}

/**
 * Note this no longer contains a source map.
 * The name was preserved to avoid breaking backwards compatibility.
 *
 * @deprecated
 */
export interface WorkflowBundlePathWithSourceMap {
  codePath: string;
  sourceMapPath: string;
}

export interface WorkflowBundle {
  code: string;
}

export type WorkflowBundleOption =
  | WorkflowBundle
  | WorkflowBundleWithSourceMap
  | WorkflowBundlePath
  | WorkflowBundlePathWithSourceMap; // eslint-disable-line deprecation/deprecation

export function isCodeBundleOption(bundleOpt: WorkflowBundleOption): bundleOpt is WorkflowBundle {
  const opt = bundleOpt as any; // Cast to access properties without TS complaining
  return typeof opt.code === 'string';
}

export function isPathBundleOption(bundleOpt: WorkflowBundleOption): bundleOpt is WorkflowBundlePath {
  const opt = bundleOpt as any; // Cast to access properties without TS complaining
  return typeof opt.codePath === 'string';
}

/**
 * Options to configure the {@link Worker}
 */
export interface WorkerOptions {
  /**
   * A connected {@link NativeConnection} instance.
   *
   * If not provided, the worker will default to connect insecurely to `localhost:7233`.
   */
  connection?: NativeConnection;

  /**
   * A human-readable string that can identify your worker
   * @default `${process.pid}@${os.hostname()}`
   */
  identity?: string;

  /**
   * A string that should be unique to the exact worker code/binary being executed.
   *
   * This is used to populate the `binaryChecksum` attribute in history events originated from this Worker.
   *
   * @default `@temporalio/worker` package name and version + checksum of workflow bundle's code
   */
  buildId?: string;

  /**
   * The namespace this worker will connect to
   *
   * @default `"default"`
   */
  namespace?: string;

  /**
   * The task queue the worker will pull from
   */
  taskQueue: string;

  /**
   * Mapping of activity name to implementation
   */
  activities?: object;

  /**
   * Path to look up workflows in, any function exported in this path will be registered as a Workflows in this Worker.
   *
   * If this option is provided to {@link Worker.create}, Webpack compliation will be triggered.
   *
   * This option is typically used for local development, for production it's preferred to pre-build the Workflow bundle
   * and pass that to {@link Worker.create} via the {@link workflowBundle} option.
   *
   * See https://docs.temporal.io/typescript/production-deploy#pre-build-code for more information.
   */
  workflowsPath?: string;

  /**
   * Use a pre-built bundle for Workflow code. Use {@link bundleWorkflowCode} to generate the bundle. The version of
   * `@temporalio/worker` used when calling `bundleWorkflowCode` must be the exact same version used when calling
   * `Worker.create`.
   *
   * This is the recommended way to deploy Workers to production.
   *
   * See https://docs.temporal.io/typescript/production-deploy#pre-build-code for more information.
   *
   * When using this option, {@link workflowsPath}, {@link bundlerOptions} and any Workflow interceptors modules
   * provided in * {@link interceptors} are not used. To use workflow interceptors, pass them via
   * {@link BundleOptions.workflowInterceptorModules} when calling {@link bundleWorkflowCode}.
   */
  workflowBundle?: WorkflowBundleOption;

  /**
   * Time to wait for pending tasks to drain after shutdown was requested.
   *
   * In-flight activities will be cancelled after this period and their current attempt will be resolved as failed if
   * they confirm cancellation (by throwing a {@link CancelledFailure} or `AbortError`).
   *
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   * @default 0
   */
  shutdownGraceTime?: string | number;

  /**
   * Time to wait before giving up on graceful shutdown and forcefully terminating the worker.
   *
   * After this duration, the worker will throw {@link GracefulShutdownPeriodExpiredError} and any running activities
   * and workflows will **not** be cleaned up. It is recommended to exit the process after this error is thrown.
   *
   * Use this option if you **must** guarantee that the worker eventually shuts down.
   *
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  shutdownForceTime?: string | number;

  /**
   * Provide a custom {@link DataConverter}.
   */
  dataConverter?: DataConverter;

  /**
   * Maximum number of Activity tasks to execute concurrently.
   * Adjust this to improve Worker resource consumption.
   * @default 100
   */
  maxConcurrentActivityTaskExecutions?: number;

  /**
   * Maximum number of Activity tasks to execute concurrently.
   * Adjust this to improve Worker resource consumption.
   * @default 100
   */
  maxConcurrentLocalActivityExecutions?: number;

  /**
   * Whether or not to poll on the Activity task queue.
   *
   * If disabled and activities are registered on the Worker, it will run only local Activities.
   *
   * @default true
   */
  enableNonLocalActivities?: boolean;

  /**
   * Limits the number of Activities per second that this Worker will process. (Does not limit the number of Local
   * Activities.) The Worker will not poll for new Activities if by doing so it might receive and execute an Activity
   * which would cause it to exceed this limit. Must be a positive number.
   *
   * If unset, no rate limiting will be applied to Worker's Activities. (`tctl task-queue describe` will display the
   * absence of a limit as 100,000.)
   */
  maxActivitiesPerSecond?: number;

  /**
   * Sets the maximum number of activities per second the task queue will dispatch, controlled
   * server-side. Note that this only takes effect upon an activity poll request. If multiple
   * workers on the same queue have different values set, they will thrash with the last poller
   * winning.
   *
   * If unset, no rate limiting will be applied to the task queue.
   */
  maxTaskQueueActivitiesPerSecond?: number;

  /**
   * Maximum number of Workflow tasks to execute concurrently.
   * Adjust this to improve Worker resource consumption.
   * @default 100
   */
  maxConcurrentWorkflowTaskExecutions?: number;

  /**
   * How long a workflow task is allowed to sit on the sticky queue before it is timed out
   * and moved to the non-sticky queue where it may be picked up by any worker.
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   * @default 10s
   */
  stickyQueueScheduleToStartTimeout?: string;

  /**
   * The number of Workflow isolates to keep in cached in memory
   *
   * Cached Workflows continue execution from their last stopping point.
   * If the Worker is asked to run an uncached Workflow, it will need to replay the entire Workflow history.
   * Use as a dial for trading memory for CPU time.
   *
   * Most users are able to fit at least 250 Workflows per GB of available memory.
   * The major factors contributing to a Workflow's memory weight are the size of allocations made
   * by the Workflow itself and the size of the Workflow bundle (code and source map).
   * For the SDK test Workflows, we managed to fit 750 Workflows per GB.
   *
   * @default `max(maxHeapMemory / 1GiB - 1, 1) * 250`
   */
  maxCachedWorkflows?: number;

  /**
   * Longest interval for throttling activity heartbeats
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   * @default 60 seconds
   */
  maxHeartbeatThrottleInterval?: number | string;

  /**
   * Default interval for throttling activity heartbeats in case
   * `ActivityOptions.heartbeat_timeout` is unset.
   * When the timeout *is* set in the `ActivityOptions`, throttling is set to
   * `heartbeat_timeout * 0.8`.
   *
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   * @default 30 seconds
   */
  defaultHeartbeatThrottleInterval?: number | string;

  /**
   * A mapping of interceptor type to a list of factories or module paths.
   *
   * By default, {@link ActivityInboundLogInterceptor} and {@link WorkflowInboundLogInterceptor} are installed. If you
   * wish to customize the interceptors while keeping the defaults, use {@link appendDefaultInterceptors}.
   *
   * When using {@link workflowBundle}, these Workflow interceptors (`WorkerInterceptors.workflowModules`) are not used.
   * Instead, provide them via {@link BundleOptions.workflowInterceptorModules} when calling {@link bundleWorkflowCode}.
   */
  interceptors?: WorkerInterceptors;

  /**
   * Implementation of the {@link Sinks} interface, a mapping of name to {@link InjectedSink}.
   *
   * Sinks are a mechanism for exporting data from the Workflow sandbox to the
   * Node.js environment, they are necessary because the Workflow has no way to
   * communicate with the outside World.
   *
   * Sinks are typically used for exporting logs, metrics and traces out from the
   * Workflow.
   *
   * Sink functions may not return values to the Workflow in order to prevent
   * breaking determinism.
   *
   * By default the defaultWorkerLogger sink is installed and is required by {@link WorkflowInboundLogInterceptor}.
   *
   * If you wish to customize the sinks while keeping the defaults, merge yours with {@link defaultSinks}.
   */
  sinks?: InjectedSinks<any>;

  /**
   * Enable opentelemetry tracing of SDK internals like polling, processing and completing tasks.
   *
   * Useful for debugging issues with the SDK itself.
   *
   * For completeness the Rust Core also generates opentelemetry spans which connect to the Worker's spans.
   * Configure {@link CoreOptions.telemetryOptions} to enable tracing in Core.
   *
   * @default false
   */
  enableSDKTracing?: boolean;

  /**
   * Whether or not to send the sources in enhanced stack trace query responses
   *
   * @default false
   */
  showStackTraceSources?: boolean;

  /**
   * If `true` Worker runs Workflows in the same thread allowing debugger to
   * attach to Workflow instances.
   *
   * Workflow execution time will not be limited by the Worker in `debugMode`.
   *
   * @default false
   */
  debugMode?: boolean;

  /**
   * Toggle whether to reuse a single V8 context for the workflow sandbox.
   *
   * Context reuse significantly decreases the amount of resources taken up by workflows.
   * From running basic stress tests we've observed 2/3 reduction in memory usage and 1/3 to 1/2 in CPU usage with this
   * feature turned on.
   *
   * This feature is experimental and requires further testing before it can be considered stable or made default.
   *
   * Introduced in SDK version 1.6.0
   *
   * @experimental
   */
  reuseV8Context?: boolean;

  bundlerOptions?: {
    /**
     * Before Workflow code is bundled with Webpack, `webpackConfigHook` is called with the Webpack
     * {@link https://webpack.js.org/configuration/ | configuration} object so you can modify it.
     */
    webpackConfigHook?: (config: WebpackConfiguration) => WebpackConfiguration;

    /**
     * List of modules to be excluded from the Workflows bundle.
     *
     * Use this option when your Workflow code references an import that cannot be used in isolation,
     * e.g. a Node.js built-in module. Modules listed here **MUST** not be used at runtime.
     *
     * > NOTE: This is an advanced option that should be used with care.
     */
    ignoreModules?: string[];
  };
}

/**
 * WorkerOptions with all of the Worker required attributes
 */
export type WorkerOptionsWithDefaults = WorkerOptions &
  Required<
    Pick<
      WorkerOptions,
      | 'namespace'
      | 'identity'
      | 'shutdownGraceTime'
      | 'maxConcurrentActivityTaskExecutions'
      | 'maxConcurrentLocalActivityExecutions'
      | 'maxConcurrentWorkflowTaskExecutions'
      | 'enableNonLocalActivities'
      | 'stickyQueueScheduleToStartTimeout'
      | 'maxCachedWorkflows'
      | 'maxHeartbeatThrottleInterval'
      | 'defaultHeartbeatThrottleInterval'
      | 'enableSDKTracing'
      | 'showStackTraceSources'
      | 'debugMode'
      | 'reuseV8Context'
    >
  > & {
    /**
     * Controls the number of Worker threads the Worker should create.
     *
     * Threads are used to create {@link https://nodejs.org/api/vm.html | vm }s for the isolated Workflow environment.
     *
     * New Workflows are created on this pool in a round-robin fashion.
     *
     * This value is not exposed at the moment.
     *
     * @default 1 for reuseV8Context, otherwise 8
     */
    workflowThreadPoolSize: number;

    /**
     * Time to wait for result when calling a Workflow isolate function.
     * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
     *
     * This value is not exposed at the moment.
     *
     * @default 5s
     */
    isolateExecutionTimeout: string | number;
  };

/**
 * {@link WorkerOptions} where the attributes the Worker requires are required and time units are converted from ms
 * formatted strings to numbers.
 */
export interface CompiledWorkerOptions extends Omit<WorkerOptionsWithDefaults, 'serverOptions'> {
  shutdownGraceTimeMs: number;
  shutdownForceTimeMs?: number;
  isolateExecutionTimeoutMs: number;
  stickyQueueScheduleToStartTimeoutMs: number;
  maxHeartbeatThrottleIntervalMs: number;
  defaultHeartbeatThrottleIntervalMs: number;
  loadedDataConverter: LoadedDataConverter;
}

/**
 * {@link WorkerOptions} with inapplicable-to-replay fields removed.
 */
export interface ReplayWorkerOptions
  extends Omit<
    WorkerOptions,
    | 'connection'
    | 'namespace'
    | 'taskQueue'
    | 'activities'
    | 'maxConcurrentActivityTaskExecutions'
    | 'maxConcurrentLocalActivityExecutions'
    | 'maxConcurrentWorkflowTaskExecutions'
    | 'maxHeartbeatThrottleInterval'
    | 'defaultHeartbeatThrottleInterval'
    | 'debugMode'
    | 'enableNonLocalActivities'
    | 'maxActivitiesPerSecond'
    | 'maxTaskQueueActivitiesPerSecond'
    | 'stickyQueueScheduleToStartTimeout'
    | 'maxCachedWorkflows'
  > {
  /**
   *  A optional name for this replay worker. It will be combined with an incremental ID to form a unique
   *  task queue for the replay worker.
   *
   *  @default "fake_replay_queue"
   */
  replayName?: string;
}

/**
 * Returns the `defaultWorkerLogger` sink which forwards logs from the Workflow sandbox to a given logger.
 *
 * @param logger a {@link Logger} - defaults to the {@link Runtime} singleton logger.
 */
export function defaultSinks(logger = Runtime.instance().logger): InjectedSinks<LoggerSinks> {
  return {
    defaultWorkerLogger: {
      trace: {
        fn(_, message, attrs) {
          logger.trace(message, attrs);
        },
      },
      debug: {
        fn(_, message, attrs) {
          logger.debug(message, attrs);
        },
      },
      info: {
        fn(_, message, attrs) {
          logger.info(message, attrs);
        },
      },
      warn: {
        fn(_, message, attrs) {
          logger.warn(message, attrs);
        },
      },
      error: {
        fn(_, message, attrs) {
          logger.error(message, attrs);
        },
      },
    },
  };
}

/**
 * Appends the default Worker logging interceptors to given interceptor arrays.
 *
 * @param logger a {@link Logger} - defaults to the {@link Runtime} singleton logger.
 */
export function appendDefaultInterceptors(
  interceptors: WorkerInterceptors,
  logger = Runtime.instance().logger
): WorkerInterceptors {
  return {
    activityInbound: [...(interceptors.activityInbound ?? []), (ctx) => new ActivityInboundLogInterceptor(ctx, logger)],
    workflowModules: [...(interceptors.workflowModules ?? []), ...defaultWorflowInterceptorModules],
  };
}

export function addDefaultWorkerOptions(options: WorkerOptions): WorkerOptionsWithDefaults {
  const { maxCachedWorkflows, showStackTraceSources, namespace, reuseV8Context, ...rest } = options;
  const debugMode = options.debugMode || isSet(process.env.TEMPORAL_DEBUG);
  return {
    namespace: namespace ?? 'default',
    identity: `${process.pid}@${os.hostname()}`,
    shutdownGraceTime: 0,
    maxConcurrentActivityTaskExecutions: 100,
    maxConcurrentLocalActivityExecutions: 100,
    enableNonLocalActivities: true,
    maxConcurrentWorkflowTaskExecutions: 100,
    stickyQueueScheduleToStartTimeout: '10s',
    maxHeartbeatThrottleInterval: '60s',
    defaultHeartbeatThrottleInterval: '30s',
    // 4294967295ms is the maximum allowed time
    isolateExecutionTimeout: debugMode ? '4294967295ms' : '5s',
    workflowThreadPoolSize: reuseV8Context ? 1 : 8,
    maxCachedWorkflows:
      maxCachedWorkflows ?? Math.floor(Math.max(v8.getHeapStatistics().heap_size_limit / GiB - 1, 1) * 250),
    enableSDKTracing: false,
    showStackTraceSources: showStackTraceSources ?? false,
    reuseV8Context: reuseV8Context ?? false,
    debugMode: debugMode ?? false,
    interceptors: appendDefaultInterceptors({}),
    sinks: defaultSinks(),
    ...rest,
  };
}

function isSet(env: string | undefined): boolean {
  if (env === undefined) return false;
  env = env.toLocaleLowerCase();
  return env === '1' || env === 't' || env === 'true';
}

export function compileWorkerOptions(opts: WorkerOptionsWithDefaults): CompiledWorkerOptions {
  return {
    ...opts,
    shutdownGraceTimeMs: msToNumber(opts.shutdownGraceTime),
    shutdownForceTimeMs: msOptionalToNumber(opts.shutdownForceTime),
    stickyQueueScheduleToStartTimeoutMs: msToNumber(opts.stickyQueueScheduleToStartTimeout),
    isolateExecutionTimeoutMs: msToNumber(opts.isolateExecutionTimeout),
    maxHeartbeatThrottleIntervalMs: msToNumber(opts.maxHeartbeatThrottleInterval),
    defaultHeartbeatThrottleIntervalMs: msToNumber(opts.defaultHeartbeatThrottleInterval),
    loadedDataConverter: loadDataConverter(opts.dataConverter),
  };
}
