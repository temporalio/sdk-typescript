import * as os from 'node:os';
import * as v8 from 'node:v8';
import type { Configuration as WebpackConfiguration } from 'webpack';
import { DataConverter, LoadedDataConverter } from '@temporalio/common';
import { Duration, msOptionalToNumber, msToNumber } from '@temporalio/common/lib/time';
import { loadDataConverter } from '@temporalio/common/lib/internal-non-workflow';
import { LoggerSinks } from '@temporalio/workflow';
import { ActivityInboundLogInterceptor } from './activity-log-interceptor';
import { NativeConnection } from './connection';
import { WorkerInterceptors } from './interceptors';
import { Logger } from './logger';
import { Runtime } from './runtime';
import { InjectedSinks } from './sinks';
import { MiB } from './utils';
import { defaultWorkflowInterceptorModules, WorkflowBundleWithSourceMap } from './workflow/bundler';

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
 *
 * Some options can significantly affect Worker's performance. Default settings are generally appropriate for
 * day-to-day development, but unlikely to be suitable for production use. We recommend that you explicitly set
 * values for every performance-related option on production deployment.
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
   *
   * Note that in most production environments, the `identity` value set by default may be unhelpful for traceability
   * purposes. It is highly recommended that you set this value to something that will allow you to efficiently identify
   * that particular Worker container/process/logs in your infrastructure (ex: the task ID allocated to this container
   * by your orchestrator).
   *
   * @default `${process.pid}@${os.hostname()}`
   */
  identity?: string;

  /**
   * A string that should be unique to the exact worker code/binary being executed.
   *
   * This is used to uniquely identify the worker's code for a handful of purposes, including the
   * worker versioning feature if you have opted into that with
   * {@link WorkerOptions.useVersioning}. It will also populate the `binaryChecksum` field
   * on older servers.
   *
   * ℹ️ Required if {@link useVersioning} is `true`.
   *
   * @default `@temporalio/worker` package name and version + checksum of workflow bundle's code
   *
   * @experimental
   */
  buildId?: string;

  /**
   * If set true, this worker opts into the worker versioning feature. This ensures it only receives
   * workflow tasks for workflows which it claims to be compatible with. The {@link buildId} field
   * is used as this worker's version when enabled.
   *
   * For more information, see https://docs.temporal.io/workers#worker-versioning
   *
   * @experimental
   */
  useVersioning?: boolean;

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
  shutdownGraceTime?: Duration;

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
  shutdownForceTime?: Duration;

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
   * Maximum number of Workflow Tasks to execute concurrently.
   *
   * In general, a Workflow Worker's performance is mostly network bound (due to communication latency with the
   * Temporal server). Accepting multiple Workflow Tasks concurrently helps compensate for network latency, until the
   * point where the Worker gets CPU bound.
   *
   * Increasing this number will have no impact if Workflow Task pollers can't fill available execution slots fast
   * enough. Therefore, when adjusting this value, you may want to similarly adjust `maxConcurrentWorkflowTaskPolls`.
   * See {@link WorkerOptions.maxConcurrentWorkflowTaskPolls} for more information.
   *
   * Also, setting this value too high might cause Workflow Task timeouts due to the fact that the Worker is not able
   * to complete processing accepted Workflow Tasks fast enough. Increasing the number of Workflow threads
   * (see {@link WorkerOptions.workflowThreadPoolSize}) may help in that case.
   *
   * General guidelines:
   * - High latency to Temporal Server => Increase this number
   * - Very short Workflow Tasks (no lengthy Local Activities) => increase this number
   * - Very long/heavy Workflow Histories => decrease this number
   * - Low CPU usage despite backlog of Workflow Tasks => increase this number
   * - High number of Workflow Task timeouts => decrease this number
   *
   * In some performance test against Temporal Cloud, running with a single Workflow thread and the Reuse V8 Context
   * option enabled, we reached peak performance with a `maxConcurrentWorkflowTaskExecutions` of `120`, and
   * `maxConcurrentWorkflowTaskPolls` of `60` (worker machine: Apple M2 Max; ping of 74 ms to Temporal Cloud;
   * load test scenario: "activityCancellation10kIters", which has short histories, running a single activity).
   * Your millage may vary.
   *
   * Can't be lower than 2 if `maxCachedWorkflows` is non-zero.
   * @default 40
   */
  maxConcurrentWorkflowTaskExecutions?: number;

  /**
   * Maximum number of Workflow Tasks to poll concurrently.
   *
   * In general, a Workflow Worker's performance is mostly network bound (due to communication latency with the
   * Temporal server). Polling multiple Workflow Tasks concurrently helps compensate for this latency, by ensuring that
   * the Worker is not starved waiting for the server to return new Workflow Tasks to execute.
   *
   * This setting is highly related with {@link WorkerOptions.maxConcurrentWorkflowTaskExecutions}. In various
   * performance tests, we generally got optimal performance by setting this value to about half of
   * `maxConcurrentWorkflowTaskExecutions`. Your millage may vary.
   *
   * Setting this value higher than needed may have negative impact on the server's performance. Consequently, the
   * server may impose a limit on the total number of concurrent Workflow Task pollers.
   *
   * General guidelines:
   * - By default, set this value to half of `maxConcurrentWorkflowTaskExecutions`.
   * - **Increase** if actual number of Workflow Tasks being processed concurrently is lower than
   *   `maxConcurrentWorkflowTaskExecutions` despite a backlog of Workflow Tasks in the Task Queue.
   * - Keep this value low for Task Queues which have very few concurrent Workflow Executions.
   *
   * Can't be higher than `maxConcurrentWorkflowTaskExecutions`, and can't be lower than 2.
   * @default min(10, maxConcurrentWorkflowTaskExecutions)
   */
  maxConcurrentWorkflowTaskPolls?: number;

  /**
   * Maximum number of Activity tasks to poll concurrently.
   *
   * Increase this setting if your Worker is failing to fill in all of its
   * `maxConcurrentActivityTaskExecutions` slots despite a backlog of Activity
   * Tasks in the Task Queue (ie. due to network latency). Can't be higher than
   * `maxConcurrentActivityTaskExecutions`.
   * @default min(2, maxConcurrentActivityTaskExecutions)
   */
  maxConcurrentActivityTaskPolls?: number;

  /**
   * How long a workflow task is allowed to sit on the sticky queue before it is timed out
   * and moved to the non-sticky queue where it may be picked up by any worker.
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   * @default 10s
   */
  stickyQueueScheduleToStartTimeout?: Duration;

  /**
   * The number of Workflow isolates to keep in cached in memory
   *
   * Cached Workflows continue execution from their last stopping point. If the Worker is asked to run an uncached
   * Workflow, it will need to fetch and replay the entire Workflow history.
   *
   * #### When `reuseV8Context` is disabled
   * The major factors contributing to a Workflow Execution's memory weight are:
   *
   * - its input arguments;
   * - allocations made and retained by the Workflow itself;
   * - allocations made and retained by all loaded librairies (including the Node JS builtin context);
   * - the size of all Payloads sent or received by the Workflow (see Core SDK issue #363).
   *
   * Most users are able to fil at least 250 Workflows per GB of available memory. In some performance test, we
   * managed to fit 750 Workflows per GB. Your millage may vary.
   *
   * #### When `reuseV8Context` is enabled
   * The major factors contributing to a Workflow Execution's memory weight are:
   *
   * - its input arguments;
   * - allocations made and retained by the Workflow itself;
   * - the size of all Payloads sent or received by the Workflow (see Core SDK issue #363).
   *
   * Since most objects are shared/reused across Workflows, the per-Workflow memory footprint is much smaller. Most
   * users are able to fit at least 600 Workflows per GB of available memory. In one reference performance test,
   * memory usage grew by approximately 1 MB per cached Workflow (that is including memory used for activity executions
   * of these Workflows). Your millage may vary.
   *
   * @default if `reuseV8Context = true`, then `max(floor(max(maxHeapMemory - 200MB, 0) * (600WF / 1024MB)), 10)`.
   *          Otherwise `max(floor(max(maxHeapMemory - 400MB, 0) * (250WF / 1024MB)), 10)`
   */
  maxCachedWorkflows?: number;

  /**
   * Controls the number of threads to be created for executing Workflow Tasks.
   *
   * Adjusting this value is generally not useful, as a Workflow Worker's performance is mostly network bound (due to
   * communication latency with the Temporal server) rather than CPU bound. Increasing this may however help reduce
   * the probability of Workflow Tasks Timeouts in some particular situations, for example when replaying many very
   * large Workflow Histories at the same time. It may also make sense to tune this value if
   * `maxConcurrentWorkflowTaskExecutions` and `maxConcurrentWorkflowTaskPolls` are increased enough so that the Worker
   * doesn't get starved waiting for Workflow Tasks to execute.
   *
   * There is no major downside in setting this value _slightly) higher than needed; consider however that there is a
   * per-thread cost, both in terms of memory footprint and CPU usage, so arbitrarily setting some high number is
   * definitely not advisable.
   *
   * ### Threading model
   *
   * All interactions with Core SDK (including polling for Workflow Activations and sending back completion results)
   * happens on the main thread. The main thread then dispatches Workflow Activations to some worker thread, which
   * create and maintain a per-Workflow isolated execution environments (aka. the Workflow Sandbox), implemented as
   * {@link https://nodejs.org/api/vm.html | VM } contexts.
   *
   * **When `reuseV8Context` is disabled**, a new VM context is created for each Workflow handled by the Worker.
   * Creating a new VM context is a relatively lengthy operation which blocks the Node.js event loop. Using multiple
   * threads helps compensate the impact of this operation on the Worker's performance.
   *
   * **When `reuseV8Context` is enabled**, a single VM context is created for each worker thread, then reused for every
   * Workflows handled by that thread (per-Workflow objects get shuffled in and out of that context on every Workflow
   * Task). Consequently, there is generally no advantage in using multiple threads when `reuseV8Context` is enabled.
   *
   * If more than one thread is used, Workflows will be load-balanced evenly between worker threads on the first
   * Activation of a Workflow Execution, based on the number of Workflows currently owned by each worker thread;
   * futher Activations of that Workflow Execution will then be handled by the same thread, until the Workflow Execution
   * gets evicted from cache.
   *
   * @default 1 if 'reuseV8Context' is enabled; 2 otherwise. Ignored if `debugMode` is enabled.
   */
  workflowThreadPoolSize?: number;

  /**
   * Longest interval for throttling activity heartbeats
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   * @default 60 seconds
   */
  maxHeartbeatThrottleInterval?: Duration;

  /**
   * Default interval for throttling activity heartbeats in case
   * `ActivityOptions.heartbeat_timeout` is unset.
   * When the timeout *is* set in the `ActivityOptions`, throttling is set to
   * `heartbeat_timeout * 0.8`.
   *
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   * @default 30 seconds
   */
  defaultHeartbeatThrottleInterval?: Duration;

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
   * Registration of a {@link SinkFunction}, including per-sink-function options.
   *
   * Sinks are a mechanism for exporting data out of the Workflow sandbox. They are typically used
   * to implement in-workflow observability mechanisms, such as logs, metrics and traces.
   *
   * To prevent non-determinism issues, sink functions may not have any observable side effect on the
   * execution of a workflow. In particular, sink functions may not return values to the workflow,
   * nor throw errors to the workflow (an exception thrown from a sink function simply get logged to
   * the {@link Runtime}'s logger).
   *
   * For similar reasons, sink functions are not executed immediately when a call is made from
   * workflow code. Instead, calls are buffered until the end of the workflow activation; they get
   * executed right before returning a completion response to Core SDK. Note that the time it takes to
   * execute sink functions delays sending a completion response to the server, and may therefore
   * induce Workflow Task Timeout errors. Sink functions should thus be kept as fast as possible.
   *
   * Sink functions are always invoked in the order that calls were maded in workflow code. Note
   * however that async sink functions are not awaited individually. Consequently, sink functions that
   * internally perform async operations may end up executing concurrently.
   *
   * Please note that sink functions only provide best-effort delivery semantics, which is generally
   * suitable for log messages and general metrics collection. However, in various situations, a sink
   * function call may execute more than once even though the sink function is configured with
   * `callInReplay: false`. Similarly, sink function execution errors only results in log messages,
   * and are therefore likely to go unnoticed. For use cases that require _at-least-once_ execution
   * guarantees, please consider using local activities instead. For use cases that require
   * _exactly-once_ or _at-most-once_ execution guarantees, please consider using regular activities.
   *
   * The SDK itself may register sinks functions required to support workflow features. At the moment, the only such
   * sink is 'defaultWorkerLogger', which is used by the workflow context logger (ie. `workflow.log.info()` and
   * friends); other sinks may be added in the future. You may override these default sinks by explicitely registering
   * sinks with the same name.
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
   * Note that we plan to turn this option on by default starting with 1.9.0.
   *
   * @default false (will change in the future)
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
      | 'useVersioning'
      | 'shutdownGraceTime'
      | 'maxConcurrentActivityTaskExecutions'
      | 'maxConcurrentLocalActivityExecutions'
      | 'maxConcurrentWorkflowTaskExecutions'
      | 'maxConcurrentWorkflowTaskPolls'
      | 'maxConcurrentActivityTaskPolls'
      | 'enableNonLocalActivities'
      | 'stickyQueueScheduleToStartTimeout'
      | 'maxCachedWorkflows'
      | 'workflowThreadPoolSize'
      | 'maxHeartbeatThrottleInterval'
      | 'defaultHeartbeatThrottleInterval'
      | 'enableSDKTracing'
      | 'showStackTraceSources'
      | 'debugMode'
      | 'reuseV8Context'
    >
  > & {
    /**
     * Time to wait for result when calling a Workflow isolate function.
     * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
     *
     * This value is not exposed at the moment.
     *
     * @default 5s
     */
    isolateExecutionTimeout: Duration;
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
    | 'useVersioning'
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
export function defaultSinks(logger?: Logger): InjectedSinks<LoggerSinks> {
  return {
    defaultWorkerLogger: {
      trace: {
        fn(_, message, attrs) {
          logger ??= Runtime.instance().logger;
          logger.trace(message, attrs);
        },
      },
      debug: {
        fn(_, message, attrs) {
          logger ??= Runtime.instance().logger;
          logger.debug(message, attrs);
        },
      },
      info: {
        fn(_, message, attrs) {
          logger ??= Runtime.instance().logger;
          logger.info(message, attrs);
        },
      },
      warn: {
        fn(_, message, attrs) {
          logger ??= Runtime.instance().logger;
          logger.warn(message, attrs);
        },
      },
      error: {
        fn(_, message, attrs) {
          logger ??= Runtime.instance().logger;
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
  logger?: Logger | undefined
): WorkerInterceptors {
  return {
    activityInbound: [...(interceptors.activityInbound ?? []), (ctx) => new ActivityInboundLogInterceptor(ctx, logger)],
    workflowModules: [...(interceptors.workflowModules ?? []), ...defaultWorkflowInterceptorModules],
  };
}

export function addDefaultWorkerOptions(options: WorkerOptions): WorkerOptionsWithDefaults {
  const {
    buildId,
    useVersioning,
    maxCachedWorkflows,
    showStackTraceSources,
    namespace,
    reuseV8Context,
    sinks,
    ...rest
  } = options;
  const debugMode = options.debugMode || isSet(process.env.TEMPORAL_DEBUG);
  const maxConcurrentWorkflowTaskExecutions = options.maxConcurrentWorkflowTaskExecutions ?? 40;
  const maxConcurrentActivityTaskExecutions = options.maxConcurrentActivityTaskExecutions ?? 100;

  const heapSizeMiB = v8.getHeapStatistics().heap_size_limit / MiB;
  const defaultMaxCachedWorkflows = reuseV8Context
    ? Math.max(Math.floor((Math.max(heapSizeMiB - 200, 0) * 600) / 1024), 10)
    : Math.max(Math.floor((Math.max(heapSizeMiB - 400, 0) * 250) / 1024), 10);

  if (useVersioning && !buildId) {
    throw new TypeError('Must provide a buildId if useVersioning is true');
  }

  return {
    namespace: namespace ?? 'default',
    identity: `${process.pid}@${os.hostname()}`,
    useVersioning: useVersioning ?? false,
    buildId,
    shutdownGraceTime: 0,
    maxConcurrentLocalActivityExecutions: 100,
    enableNonLocalActivities: true,
    maxConcurrentWorkflowTaskPolls: Math.min(10, maxConcurrentWorkflowTaskExecutions),
    maxConcurrentActivityTaskPolls: Math.min(10, maxConcurrentActivityTaskExecutions),
    stickyQueueScheduleToStartTimeout: '10s',
    maxHeartbeatThrottleInterval: '60s',
    defaultHeartbeatThrottleInterval: '30s',
    // 4294967295ms is the maximum allowed time
    isolateExecutionTimeout: debugMode ? '4294967295ms' : '5s',
    workflowThreadPoolSize: reuseV8Context ? 1 : 2,
    maxCachedWorkflows: maxCachedWorkflows ?? defaultMaxCachedWorkflows,
    enableSDKTracing: false,
    showStackTraceSources: showStackTraceSources ?? false,
    reuseV8Context: reuseV8Context ?? false,
    debugMode: debugMode ?? false,
    interceptors: appendDefaultInterceptors({}),
    sinks: { ...defaultSinks(), ...sinks },
    ...rest,
    maxConcurrentWorkflowTaskExecutions,
    maxConcurrentActivityTaskExecutions,
  };
}

function isSet(env: string | undefined): boolean {
  if (env === undefined) return false;
  env = env.toLocaleLowerCase();
  return env === '1' || env === 't' || env === 'true';
}

export function compileWorkerOptions(opts: WorkerOptionsWithDefaults): CompiledWorkerOptions {
  if (opts.maxCachedWorkflows !== 0 && opts.maxCachedWorkflows < 2) {
    Runtime.instance().logger.warn(
      'maxCachedWorkflows must be either 0 (ie. cache is disabled) or greater than 1. Defaulting to 2.'
    );
    opts.maxCachedWorkflows = 2;
  }
  if (opts.maxCachedWorkflows > 0 && opts.maxConcurrentWorkflowTaskExecutions > opts.maxCachedWorkflows) {
    Runtime.instance().logger.warn(
      "maxConcurrentWorkflowTaskExecutions can't exceed maxCachedWorkflows (unless cache is disabled). Defaulting to maxCachedWorkflows."
    );
    opts.maxConcurrentWorkflowTaskExecutions = opts.maxCachedWorkflows;
  }
  if (opts.maxCachedWorkflows > 0 && opts.maxConcurrentWorkflowTaskExecutions < 2) {
    Runtime.instance().logger.warn(
      "maxConcurrentWorkflowTaskExecutions can't be lower than 2 if maxCachedWorkflows is non-zero. Defaulting to 2."
    );
    opts.maxConcurrentWorkflowTaskExecutions = 2;
  }

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
