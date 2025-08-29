import * as os from 'node:os';
import * as v8 from 'node:v8';
import type { Configuration as WebpackConfiguration } from 'webpack';
import * as nexus from 'nexus-rpc';
import {
  ActivityFunction,
  DataConverter,
  LoadedDataConverter,
  MetricMeter,
  VersioningBehavior,
  WorkerDeploymentVersion,
} from '@temporalio/common';
import { Duration, msOptionalToNumber, msToNumber } from '@temporalio/common/lib/time';
import { loadDataConverter } from '@temporalio/common/lib/internal-non-workflow';
import { LoggerSinks } from '@temporalio/workflow';
import { Context } from '@temporalio/activity';
import { native } from '@temporalio/core-bridge';
import { throwIfReservedName } from '@temporalio/common/lib/reserved';
import { ActivityInboundLogInterceptor } from './activity-log-interceptor';
import { NativeConnection } from './connection';
import { CompiledWorkerInterceptors, WorkerInterceptors } from './interceptors';
import { Logger } from './logger';
import { initLoggerSink } from './workflow/logger';
import { initMetricSink } from './workflow/metrics';
import { Runtime } from './runtime';
import { InjectedSinks } from './sinks';
import { MiB } from './utils';
import { WorkflowBundleWithSourceMap } from './workflow/bundler';
import { asNativeTuner, WorkerTuner } from './worker-tuner';

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
   * :warning: NOTE: When used with versioning, you must pass this build ID to {@link updateBuildIdCompatibility}.
   * Otherwise, this Worker will not pick up any tasks.
   *
   * @default `@temporalio/worker` package name and version + checksum of workflow bundle's code
   *
   * @experimental The Worker Versioning API is still being designed. Major changes are expected.
   * @deprecated Use {@link workerDeploymentOptions} instead.
   */
  buildId?: string;

  /**
   * If set true, this worker opts into the worker versioning feature. This ensures it only receives
   * workflow tasks for workflows which it claims to be compatible with. The {@link buildId} field
   * is used as this worker's version when enabled.
   *
   * For more information, see https://docs.temporal.io/workers#worker-versioning
   *
   * @experimental The Worker Versioning API is still being designed. Major changes are expected.
   * @deprecated Use {@link workerDeploymentOptions} instead.
   */
  useVersioning?: boolean;

  /**
   * Deployment options for the worker. Exclusive with `build_id` and `use_worker_versioning`.
   *
   * @experimental Deployment based versioning is still experimental.
   */
  workerDeploymentOptions?: WorkerDeploymentOptions;

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
   * An array of Nexus services
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  nexusServices?: nexus.ServiceHandler<any>[];

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
   *
   * When bundling workflows ahead of time, make sure to provide custom payload and failure
   * converter paths as options to `bundleWorkflowCode`.
   */
  dataConverter?: DataConverter;

  /**
   * Provide a custom {@link WorkerTuner}.
   *
   * Mutually exclusive with the {@link maxConcurrentWorkflowTaskExecutions}, {@link
   * maxConcurrentActivityTaskExecutions}, and {@link maxConcurrentLocalActivityExecutions} options.
   *
   * @experimental Worker Tuner is an experimental feature and may be subject to change.
   */
  tuner?: WorkerTuner;

  /**
   * Maximum number of Activity tasks to execute concurrently.
   * Adjust this to improve Worker resource consumption.
   *
   * Mutually exclusive with the {@link tuner} option.
   *
   * @default 100 if no {@link tuner} is set
   */
  maxConcurrentActivityTaskExecutions?: number;

  /**
   * Maximum number of Activity tasks to execute concurrently.
   * Adjust this to improve Worker resource consumption.
   *
   * Mutually exclusive with the {@link tuner} option.
   *
   * @default 100 if no {@link tuner} is set
   */
  maxConcurrentLocalActivityExecutions?: number;

  /**
   * Maximum number of Nexus tasks to execute concurrently.
   * Adjust this to improve Worker resource consumption.
   *
   * Mutually exclusive with the {@link tuner} option.
   *
   * @default 100 if no {@link tuner} is set
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  maxConcurrentNexusTaskExecutions?: number;

  /**
   * Whether or not to poll on the Activity task queue.
   *
   * If disabled and activities are registered on the Worker, it will run only local Activities.
   * This setting is ignored if no activity is registed on the Worker.
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
   *
   * Mutually exclusive with the {@link tuner} option.
   *
   * @default 40 if no {@link tuner} is set
   */
  maxConcurrentWorkflowTaskExecutions?: number;

  /**
   * `maxConcurrentWorkflowTaskPolls` * this number = the number of max pollers that will
   * be allowed for the nonsticky queue when sticky tasks are enabled. If both defaults are used,
   * the sticky queue will allow 8 max pollers while the nonsticky queue will allow 2. The
   * minimum for either poller is 1, so if `maxConcurrentWorkflowTaskPolls` is 1 and sticky queues are
   * enabled, there will be 2 concurrent polls.
   *
   * @default 0.2
   */
  nonStickyToStickyPollRatio?: number;

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
   * Specify the behavior of workflow task polling.
   *
   * @default A fixed maximum whose value is min(10, maxConcurrentWorkflowTaskExecutions).
   */
  workflowTaskPollerBehavior?: PollerBehavior;

  /**
   * Specify the behavior of activity task polling.
   *
   * @default A fixed maximum whose value is min(10, maxConcurrentActivityTaskExecutions).
   */
  activityTaskPollerBehavior?: PollerBehavior;

  /**
   * Specify the behavior of Nexus task polling.
   *
   * @default A fixed maximum whose value is min(10, maxConcurrentNexusTaskExecutions).
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  nexusTaskPollerBehavior?: PollerBehavior;

  /**
   * Maximum number of Activity tasks to poll concurrently.
   *
   * Increase this setting if your Worker is failing to fill in all of its
   * `maxConcurrentActivityTaskExecutions` slots despite a backlog of Activity
   * Tasks in the Task Queue (ie. due to network latency). Can't be higher than
   * `maxConcurrentActivityTaskExecutions`.
   * @default min(10, maxConcurrentActivityTaskExecutions)
   */
  maxConcurrentActivityTaskPolls?: number;

  /**
   * Maximum number of Nexus tasks to poll concurrently.
   *
   * Increase this setting if your Worker is failing to fill in all of its
   * `maxConcurrentNexusTaskExecutions` slots despite a low match rate of Nexus
   * Tasks in the Task Queue (ie. due to network latency). Can't be higher than
   * `maxConcurrentNexusTaskExecutions`.
   *
   * @default min(10, maxConcurrentNexusTaskExecutions)
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  maxConcurrentNexusTaskPolls?: number;

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
   * Interceptors are called in order, from the first to the last, each one making the call to the next one, and the
   * last one calling the original (SDK provided) function.
   *
   * By default, {@link WorkflowInboundLogInterceptor} is installed. If you wish to customize the interceptors while
   * keeping the defaults, use {@link appendDefaultInterceptors}.

   * When using {@link workflowBundle}, these Workflow interceptors (`WorkerInterceptors.workflowModules`) are not used.
   * Instead, provide them via {@link BundleOptions.workflowInterceptorModules} when calling {@link bundleWorkflowCode}.
   *
   * Before v1.9.0, calling `appendDefaultInterceptors()` was required when registering custom interceptors in order to
   * preserve SDK's logging interceptors. This is no longer the case.
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
   * Sink names starting with `__temporal_` are reserved for use by the SDK itself. Do not register
   * or use such sink. Registering a sink named `defaultWorkerLogger` to redirect workflow logs to a
   * custom logger is deprecated. Register a custom logger through {@link Runtime.logger} instead.
   */
  sinks?: InjectedSinks<any>;

  /**
   * @deprecated SDK tracing is no longer supported. This option is ignored.
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
   * @default false unless the `TEMPORAL_DEBUG` environment variable is set.
   */
  debugMode?: boolean;

  /**
   * Toggle whether to reuse a single V8 context for the workflow sandbox.
   *
   * Context reuse significantly decreases the amount of resources taken up by workflows.
   * From running basic stress tests we've observed 2/3 reduction in memory usage and 1/3 to 1/2 in CPU usage with this
   * feature turned on.
   *
   * NOTE: We strongly recommend enabling the Reuse V8 Context execution model, and there is currently no known reason
   * not to use it. Support for the legacy execution model may get removed at some point in the future. Please report
   * any issue that requires you to disable `reuseV8Context`.
   *
   * @default true
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

export type PollerBehavior = PollerBehaviorSimpleMaximum | PollerBehaviorAutoscaling;

/**
 * A poller behavior that will automatically scale the number of pollers based on feedback
 * from the server. A slot must be available before beginning polling.
 *
 * @experimental Poller autoscaling is currently experimental and may change in future versions.
 */
export interface PollerBehaviorAutoscaling {
  type: 'autoscaling';
  /**
   * At least this many poll calls will always be attempted (assuming slots are available).
   * Cannot be lower than 1. Defaults to 1.
   */
  minimum?: number;
  /**
   * At most this many poll calls will ever be open at once. Must be >= `minimum`.
   * Defaults to 100.
   */
  maximum?: number;
  /**
   * This many polls will be attempted initially before scaling kicks in. Must be between
   * `minimum` and `maximum`.
   * Defaults to 5.
   */
  initial?: number;
}

/**
 * A poller behavior that will attempt to poll as long as a slot is available, up to the
 * provided maximum.
 */
export interface PollerBehaviorSimpleMaximum {
  type: 'simple-maximum';
  /**
   * The maximum poller number, assumes the same default as described in
   * {@link WorkerOptions.maxConcurrentWorkflowTaskPolls},
   * {@link WorkerOptions.maxConcurrentActivityTaskPolls}, or
   * {@link WorkerOptions.maxConcurrentNexusTaskPolls} .
   */
  maximum?: number;
}

/**
 * Allows specifying the deployment version of the worker and whether to use deployment-based
 * worker versioning.
 *
 * @experimental Deployment based versioning is still experimental.
 */
export type WorkerDeploymentOptions = {
  /**
   * The deployment version of the worker.
   */
  version: WorkerDeploymentVersion;

  /**
   * Whether to use deployment-based worker versioning.
   */
  useWorkerVersioning: boolean;

  /**
   * The default versioning behavior to use for all workflows on this worker. Specifying a default
   * behavior is required.
   */
  defaultVersioningBehavior: VersioningBehavior;
};

// Replay Worker ///////////////////////////////////////////////////////////////////////////////////

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
    | 'nexusServices'
    | 'tuner'
    | 'maxConcurrentActivityTaskExecutions'
    | 'maxConcurrentLocalActivityExecutions'
    | 'maxConcurrentWorkflowTaskExecutions'
    | 'maxConcurrentNexusTaskExecutions'
    | 'maxConcurrentActivityTaskPolls'
    | 'maxConcurrentWorkflowTaskPolls'
    | 'maxConcurrentNexusTaskPolls'
    | 'workflowTaskPollerBehavior'
    | 'activityTaskPollerBehavior'
    | 'nexusTaskPollerBehavior'
    | 'nonStickyToStickyPollRatio'
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

// Workflow Bundle /////////////////////////////////////////////////////////////////////////////////

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

// Sinks and Interceptors //////////////////////////////////////////////////////////////////////////

/**
 * Build the sink used internally by the SDK to forwards log messages from the Workflow sandbox to an actual logger.
 *
 * @param logger a {@link Logger} - defaults to the {@link Runtime} singleton logger.
 * @deprecated Calling `defaultSink()` is no longer required. To configure a custom logger, set the
 *             {@link Runtime.logger} property instead.
 */
// eslint-disable-next-line deprecation/deprecation
export function defaultSinks(logger?: Logger): InjectedSinks<LoggerSinks> {
  // initLoggerSink() returns a sink that complies to the new LoggerSinksInternal API (ie. named __temporal_logger), but
  // code that is still calling defaultSinks() expects return type to match the deprecated LoggerSinks API. Silently
  // cast just to mask type checking issues, even though we know this is wrong. Users shouldn't call functions directly
  // on the returned object anyway.

  // If no logger was provided, the legacy behavior was to _lazily_ set the sink's logger to the Runtime's logger.
  // This was required because we may call defaultSinks() before the Runtime is initialized. We preserve that behavior
  // here by silently not initializing the sink if no logger is provided.
  // eslint-disable-next-line deprecation/deprecation
  if (!logger) return {} as InjectedSinks<LoggerSinks>;

  // Register the logger sink with its historical name
  const { __temporal_logger: defaultWorkerLogger } = initLoggerSink(logger);
  return { defaultWorkerLogger } satisfies InjectedSinks<LoggerSinks>; // eslint-disable-line deprecation/deprecation
}

/**
 * Appends the default Worker logging interceptors to given interceptor arrays.
 *
 * @param logger a {@link Logger} - defaults to the {@link Runtime} singleton logger.
 *
 * @deprecated Calling `appendDefaultInterceptors()` is no longer required. To configure a custom logger, set the
 *             {@link Runtime.logger} property instead.
 */
export function appendDefaultInterceptors(
  interceptors: WorkerInterceptors,
  logger?: Logger | undefined
): WorkerInterceptors {
  if (!logger || logger === Runtime.instance().logger) return interceptors;

  return {
    activityInbound: [
      // eslint-disable-next-line deprecation/deprecation
      (ctx) => new ActivityInboundLogInterceptor(ctx, logger),
      // eslint-disable-next-line deprecation/deprecation
      ...(interceptors.activityInbound ?? []),
    ],
    activity: interceptors.activity,
    workflowModules: interceptors.workflowModules,
  };
}

function compileWorkerInterceptors({
  client,
  activity,
  activityInbound, // eslint-disable-line deprecation/deprecation
  nexus,
  workflowModules,
}: Required<WorkerInterceptors>): CompiledWorkerInterceptors {
  return {
    client: {
      workflow: client?.workflow ?? [],
      schedule: client?.schedule ?? [],
    },
    activity: [...activityInbound.map((factory) => (ctx: Context) => ({ inbound: factory(ctx) })), ...activity],
    nexus: nexus ?? [],
    workflowModules,
  };
}

// Compile Options /////////////////////////////////////////////////////////////////////////////////

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
      | 'nonStickyToStickyPollRatio'
      | 'enableNonLocalActivities'
      | 'stickyQueueScheduleToStartTimeout'
      | 'maxCachedWorkflows'
      | 'workflowThreadPoolSize'
      | 'maxHeartbeatThrottleInterval'
      | 'defaultHeartbeatThrottleInterval'
      | 'showStackTraceSources'
      | 'debugMode'
      | 'reuseV8Context'
      | 'tuner'
    >
  > & {
    interceptors: Required<WorkerInterceptors>;

    /**
     * Time to wait for result when calling a Workflow isolate function.
     * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
     *
     * This value is not exposed at the moment.
     *
     * @default 5s
     */
    isolateExecutionTimeout: Duration;

    workflowTaskPollerBehavior: Required<PollerBehavior>;
    activityTaskPollerBehavior: Required<PollerBehavior>;
    nexusTaskPollerBehavior: Required<PollerBehavior>;
  };

/**
 * {@link WorkerOptions} where the attributes the Worker requires are required and time units are converted from ms
 * formatted strings to numbers.
 */
export interface CompiledWorkerOptions
  extends Omit<WorkerOptionsWithDefaults, 'interceptors' | 'activities' | 'nexusServices' | 'tuner'> {
  interceptors: CompiledWorkerInterceptors;
  shutdownGraceTimeMs: number;
  shutdownForceTimeMs?: number;
  isolateExecutionTimeoutMs: number;
  stickyQueueScheduleToStartTimeoutMs: number;
  maxHeartbeatThrottleIntervalMs: number;
  defaultHeartbeatThrottleIntervalMs: number;
  loadedDataConverter: LoadedDataConverter;
  activities: Map<string, ActivityFunction>;
  nexusServiceRegistry?: nexus.ServiceRegistry;
  tuner: native.WorkerTunerOptions;
}

export type CompiledWorkerOptionsWithBuildId = CompiledWorkerOptions & {
  buildId: string;
};

function addDefaultWorkerOptions(
  options: WorkerOptions,
  logger: Logger,
  metricMeter: MetricMeter
): WorkerOptionsWithDefaults {
  const {
    buildId, // eslint-disable-line deprecation/deprecation
    useVersioning, // eslint-disable-line deprecation/deprecation
    maxCachedWorkflows,
    showStackTraceSources,
    namespace,
    sinks,
    nonStickyToStickyPollRatio,
    interceptors,
    maxConcurrentActivityTaskExecutions,
    maxConcurrentLocalActivityExecutions,
    maxConcurrentWorkflowTaskExecutions,
    maxConcurrentNexusTaskExecutions,
    workflowTaskPollerBehavior,
    activityTaskPollerBehavior,
    nexusTaskPollerBehavior,
    ...rest
  } = options;
  const debugMode = options.debugMode || isSet(process.env.TEMPORAL_DEBUG);

  const reuseV8Context = options.reuseV8Context ?? true;

  const heapSizeMiB = v8.getHeapStatistics().heap_size_limit / MiB;
  const defaultMaxCachedWorkflows = reuseV8Context
    ? Math.max(Math.floor((Math.max(heapSizeMiB - 200, 0) * 600) / 1024), 10)
    : Math.max(Math.floor((Math.max(heapSizeMiB - 400, 0) * 250) / 1024), 10);

  if (useVersioning && !buildId) {
    throw new TypeError('Must provide a buildId if useVersioning is true');
  }

  // Difficult to predict appropriate poll numbers for resource based slots
  let maxWFTPolls = 10;
  let maxATPolls = 10;
  let maxNexusTaskPolls = 10;
  let setTuner: WorkerTuner;
  if (rest.tuner !== undefined) {
    if (maxConcurrentActivityTaskExecutions !== undefined) {
      throw new TypeError('Cannot set both tuner and maxConcurrentActivityTaskExecutions');
    }
    if (maxConcurrentLocalActivityExecutions !== undefined) {
      throw new TypeError('Cannot set both tuner and maxConcurrentLocalActivityExecutions');
    }
    if (maxConcurrentWorkflowTaskExecutions !== undefined) {
      throw new TypeError('Cannot set both tuner and maxConcurrentWorkflowTaskExecutions');
    }
    setTuner = rest.tuner;
  } else {
    const maxWft = maxConcurrentWorkflowTaskExecutions ?? 40;
    maxWFTPolls = Math.min(maxWFTPolls, maxWft);
    const maxAT = maxConcurrentActivityTaskExecutions ?? 100;
    maxATPolls = Math.min(maxATPolls, maxAT);
    const maxLAT = maxConcurrentLocalActivityExecutions ?? 100;
    const maxNexusTasks = maxConcurrentNexusTaskExecutions ?? 100;
    maxNexusTaskPolls = Math.min(maxNexusTaskPolls, maxNexusTasks);
    setTuner = {
      workflowTaskSlotSupplier: {
        type: 'fixed-size',
        numSlots: maxWft,
      },
      activityTaskSlotSupplier: {
        type: 'fixed-size',
        numSlots: maxAT,
      },
      localActivityTaskSlotSupplier: {
        type: 'fixed-size',
        numSlots: maxLAT,
      },
      nexusTaskSlotSupplier: {
        type: 'fixed-size',
        numSlots: maxNexusTasks,
      },
    };
  }

  const createPollerBehavior = (defaultMax: number, behavior?: PollerBehavior): Required<PollerBehavior> =>
    !behavior
      ? { type: 'simple-maximum', maximum: defaultMax }
      : behavior.type === 'simple-maximum'
        ? { type: 'simple-maximum', maximum: behavior.maximum ?? defaultMax }
        : {
            type: 'autoscaling',
            minimum: behavior.minimum ?? 1,
            initial: behavior.initial ?? 5,
            maximum: behavior.maximum ?? 100,
          };

  const wftPollerBehavior = createPollerBehavior(maxWFTPolls, workflowTaskPollerBehavior);
  const atPollerBehavior = createPollerBehavior(maxATPolls, activityTaskPollerBehavior);
  const nexusPollerBehavior = createPollerBehavior(maxNexusTaskPolls, nexusTaskPollerBehavior);

  return {
    namespace: namespace ?? 'default',
    identity: `${process.pid}@${os.hostname()}`,
    useVersioning: useVersioning ?? false,
    buildId,
    shutdownGraceTime: 0,
    enableNonLocalActivities: true,
    workflowTaskPollerBehavior: wftPollerBehavior,
    activityTaskPollerBehavior: atPollerBehavior,
    nexusTaskPollerBehavior: nexusPollerBehavior,
    stickyQueueScheduleToStartTimeout: '10s',
    maxHeartbeatThrottleInterval: '60s',
    defaultHeartbeatThrottleInterval: '30s',
    // 4294967295ms is the maximum allowed time
    isolateExecutionTimeout: debugMode ? '4294967295ms' : '5s',
    workflowThreadPoolSize: reuseV8Context ? 1 : 2,
    maxCachedWorkflows: maxCachedWorkflows ?? defaultMaxCachedWorkflows,
    showStackTraceSources: showStackTraceSources ?? false,
    debugMode: debugMode ?? false,
    interceptors: {
      client: {
        workflow: interceptors?.client?.workflow ?? [],
        schedule: interceptors?.client?.schedule ?? [],
      },
      activity: interceptors?.activity ?? [],
      nexus: interceptors?.nexus ?? [],
      // eslint-disable-next-line deprecation/deprecation
      activityInbound: interceptors?.activityInbound ?? [],
      workflowModules: interceptors?.workflowModules ?? [],
    },
    nonStickyToStickyPollRatio: nonStickyToStickyPollRatio ?? 0.2,
    sinks: {
      ...initLoggerSink(logger),
      ...initMetricSink(metricMeter),
      // Fix deprecated registration of the 'defaultWorkerLogger' sink
      ...(sinks?.defaultWorkerLogger ? { __temporal_logger: sinks.defaultWorkerLogger } : {}),
      ...sinks,
    },
    ...rest,
    tuner: setTuner,
    reuseV8Context,
  };
}

export function compileWorkerOptions(
  rawOpts: WorkerOptions,
  logger: Logger,
  metricMeter: MetricMeter
): CompiledWorkerOptions {
  // Validate sink names to ensure they don't use reserved prefixes/names
  if (rawOpts.sinks) {
    for (const sinkName of Object.keys(rawOpts.sinks)) {
      throwIfReservedName('sink', sinkName);
    }
  }

  const opts = addDefaultWorkerOptions(rawOpts, logger, metricMeter);
  if (opts.maxCachedWorkflows !== 0 && opts.maxCachedWorkflows < 2) {
    logger.warn('maxCachedWorkflows must be either 0 (ie. cache is disabled) or greater than 1. Defaulting to 2.');
    opts.maxCachedWorkflows = 2;
  }

  if (opts.maxConcurrentWorkflowTaskExecutions !== undefined) {
    if (opts.maxCachedWorkflows > 0 && opts.maxConcurrentWorkflowTaskExecutions > opts.maxCachedWorkflows) {
      logger.warn(
        "maxConcurrentWorkflowTaskExecutions can't exceed maxCachedWorkflows (unless cache is disabled). Defaulting to maxCachedWorkflows."
      );
      opts.maxConcurrentWorkflowTaskExecutions = opts.maxCachedWorkflows;
    }
    if (opts.maxCachedWorkflows > 0 && opts.maxConcurrentWorkflowTaskExecutions < 2) {
      logger.warn(
        "maxConcurrentWorkflowTaskExecutions can't be lower than 2 if maxCachedWorkflows is non-zero. Defaulting to 2."
      );
      opts.maxConcurrentWorkflowTaskExecutions = 2;
    }
  }

  const activities = new Map(Object.entries(opts.activities ?? {}).filter(([_, v]) => typeof v === 'function'));
  for (const activityName of activities.keys()) {
    throwIfReservedName('activity', activityName);
  }

  const tuner = asNativeTuner(opts.tuner, logger);

  return {
    ...opts,
    interceptors: compileWorkerInterceptors(opts.interceptors),
    shutdownGraceTimeMs: msToNumber(opts.shutdownGraceTime),
    shutdownForceTimeMs: msOptionalToNumber(opts.shutdownForceTime),
    stickyQueueScheduleToStartTimeoutMs: msToNumber(opts.stickyQueueScheduleToStartTimeout),
    isolateExecutionTimeoutMs: msToNumber(opts.isolateExecutionTimeout),
    maxHeartbeatThrottleIntervalMs: msToNumber(opts.maxHeartbeatThrottleInterval),
    defaultHeartbeatThrottleIntervalMs: msToNumber(opts.defaultHeartbeatThrottleInterval),
    loadedDataConverter: loadDataConverter(opts.dataConverter),
    activities,
    nexusServiceRegistry: nexusServiceRegistryFromOptions(opts),
    enableNonLocalActivities: opts.enableNonLocalActivities && activities.size > 0,
    tuner,
  };
}

function nexusServiceRegistryFromOptions(opts: WorkerOptions): nexus.ServiceRegistry | undefined {
  if (opts.nexusServices == null || opts.nexusServices.length === 0) {
    return undefined;
  }
  return nexus.ServiceRegistry.create(opts.nexusServices);
}

export function toNativeWorkerOptions(opts: CompiledWorkerOptionsWithBuildId): native.WorkerOptions {
  return {
    identity: opts.identity,
    buildId: opts.buildId, // eslint-disable-line deprecation/deprecation
    useVersioning: opts.useVersioning, // eslint-disable-line deprecation/deprecation
    workerDeploymentOptions: toNativeDeploymentOptions(opts.workerDeploymentOptions),
    taskQueue: opts.taskQueue,
    namespace: opts.namespace,
    tuner: opts.tuner,
    nonStickyToStickyPollRatio: opts.nonStickyToStickyPollRatio,
    workflowTaskPollerBehavior: toNativeTaskPollerBehavior(opts.workflowTaskPollerBehavior),
    activityTaskPollerBehavior: toNativeTaskPollerBehavior(opts.activityTaskPollerBehavior),
    nexusTaskPollerBehavior: toNativeTaskPollerBehavior(opts.nexusTaskPollerBehavior),
    enableNonLocalActivities: opts.enableNonLocalActivities,
    stickyQueueScheduleToStartTimeout: msToNumber(opts.stickyQueueScheduleToStartTimeout),
    maxCachedWorkflows: opts.maxCachedWorkflows,
    maxHeartbeatThrottleInterval: msToNumber(opts.maxHeartbeatThrottleInterval),
    defaultHeartbeatThrottleInterval: msToNumber(opts.defaultHeartbeatThrottleInterval),
    maxTaskQueueActivitiesPerSecond: opts.maxTaskQueueActivitiesPerSecond ?? null,
    maxActivitiesPerSecond: opts.maxActivitiesPerSecond ?? null,
    shutdownGraceTime: msToNumber(opts.shutdownGraceTime),
  };
}

export function toNativeTaskPollerBehavior(behavior: Required<PollerBehavior>): native.PollerBehavior {
  switch (behavior.type) {
    case 'simple-maximum':
      return {
        type: 'simple-maximum',
        maximum: behavior.maximum,
      };
    case 'autoscaling':
      return {
        type: 'autoscaling',
        minimum: behavior.minimum,
        initial: behavior.initial,
        maximum: behavior.maximum,
      };
    default:
      throw new Error(`Unknown poller behavior type: ${(behavior as any).type}`);
  }
}

function toNativeDeploymentOptions(options?: WorkerDeploymentOptions): native.WorkerDeploymentOptions | null {
  if (options === undefined) {
    return null;
  }
  let vb: native.VersioningBehavior;
  switch (options.defaultVersioningBehavior) {
    case 'PINNED':
      vb = { type: 'pinned' };
      break;
    case 'AUTO_UPGRADE':
      vb = { type: 'auto-upgrade' };
      break;
    default:
      options.defaultVersioningBehavior satisfies never;
      throw new Error(`Unknown versioning behavior: ${options.defaultVersioningBehavior}`);
  }
  return {
    version: options.version,
    useWorkerVersioning: options.useWorkerVersioning,
    defaultVersioningBehavior: vb,
  };
}

// Utils ///////////////////////////////////////////////////////////////////////////////////////////

function isSet(env: string | undefined): boolean {
  if (env === undefined) return false;
  env = env.toLocaleLowerCase();
  return env === '1' || env === 't' || env === 'true';
}
