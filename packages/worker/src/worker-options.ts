import { DataConverter, LoadedDataConverter } from '@temporalio/common';
import { loadDataConverter } from '@temporalio/internal-non-workflow-common';
import { ActivityInterface, msToNumber } from '@temporalio/internal-workflow-common';
import os from 'os';
import { WorkerInterceptors } from './interceptors';
import { InjectedSinks } from './sinks';
import { GiB } from './utils';
import { NativeConnection } from './connection';

export type WorkflowBundle = { code: string } | { path: string };

export function isCodeBundleOption(bundleOpt: WorkflowBundle): bundleOpt is { code: string } {
  return typeof (bundleOpt as any).code === 'string';
}

export function isPathBundleOption(bundleOpt: WorkflowBundle): bundleOpt is { path: string } {
  return typeof (bundleOpt as any).path === 'string';
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
   * Mapping of activity name to implementation.
   */
  activities?: ActivityInterface;

  /**
   * Path to look up workflows in, any function exported in this path will be registered as a Workflows in this Worker.
   *
   * If this option is provided to {@link Worker.create}, Webpack compliation will be triggered.
   *
   * This option is typically used for local development, for production it's preferred to pre-build the Workflow bundle
   * and pass that to {@link Worker.create} via the {@link workflowBundle} option.
   *
   * See https://docs.temporal.io/docs/typescript/production-deploy#pre-build-code for more information.
   */
  workflowsPath?: string;

  /**
   * Use a pre-built bundle for Workflow code.
   * Use {@link bundleWorkflowCode} to genrate a bundle.
   *
   * This is the recommended way to deploy Workers to production.
   *
   * See https://docs.temporal.io/docs/typescript/production-deploy#pre-build-code for more information.
   */
  workflowBundle?: WorkflowBundle;

  /**
   * Time to wait for pending tasks to drain after shutdown was requested.
   *
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   * @default 5s
   */
  shutdownGraceTime?: string | number;

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
   * Maximum number of Workflow tasks to execute concurrently.
   * Adjust this to improve Worker resource consumption.
   * @default 100
   */
  maxConcurrentWorkflowTaskExecutions?: number;

  /**
   * Maximum number of concurrent poll Workflow task requests to perform at a time.
   * Higher values will result in higher throughput and load on the Worker.
   * If your Worker is overloaded, tasks might start timing out in which case, reduce this value.
   *
   * @default 5
   */
  maxConcurrentWorkflowTaskPolls?: number;
  /**
   * Maximum number of concurrent poll Activity task requests to perform at a time.
   * Higher values will result in higher throughput and load on the Worker.
   * If your Worker is overloaded, tasks might start timing out in which case, reduce this value.
   *
   * @default 5
   */
  maxConcurrentActivityTaskPolls?: number;

  /**
   * `maxConcurrentWorkflowTaskPolls` * this number = the number of max pollers that will
   * be allowed for the nonsticky queue when sticky tasks are enabled. If both defaults are used,
   * the sticky queue will allow 4 max pollers while the nonsticky queue will allow one. The
   * minimum for either poller is 1, so if `max_concurrent_wft_polls` is 1 and sticky queues are
   * enabled, there will be 2 concurrent polls.
   * @default 0.2
   */
  nonStickyToStickyPollRatio?: number;

  /**
   * How long a workflow task is allowed to sit on the sticky queue before it is timed out
   * and moved to the non-sticky queue where it may be picked up by any worker.
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
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
   * You should be able to fit about 500 Workflows per GB of memory dependening on your Workflow bundle size.
   * For the SDK test Workflows, we managed to fit 750 Workflows per GB.
   *
   * This number is impacted by the the Worker's {@link maxIsolateMemoryMB} option.
   *
   * @default `max(os.totalmem() / 1GiB - 1, 1) * 200`
   */
  maxCachedWorkflows?: number;

  /**
   * Longest interval for throttling activity heartbeats
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   * @default 60 seconds
   */
  maxHeartbeatThrottleInterval?: number | string;

  /**
   * Default interval for throttling activity heartbeats in case
   * `ActivityOptions.heartbeat_timeout` is unset.
   * When the timeout *is* set in the `ActivityOptions`, throttling is set to
   * `heartbeat_timeout * 0.8`.
   *
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   * @default 30 seconds
   */
  defaultHeartbeatThrottleInterval?: number | string;

  /**
   * A mapping of interceptor type to a list of factories or module paths
   */
  interceptors?: WorkerInterceptors;
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
   * If `true` Worker runs Workflows in the same thread allowing debugger to
   * attach to Workflow instances.
   *
   * Workflow execution time will not be limited by the Worker in `debugMode`.
   *
   * @default false
   */
  debugMode?: boolean;

  bundlerOptions?: {
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
  // TODO: implement all of these
  // maxConcurrentLocalActivityExecutions?: number; // defaults to 200
  // maxTaskQueueActivitiesPerSecond?: number;
  // maxWorkerActivitiesPerSecond?: number;
  // isLocalActivityWorkerOnly?: boolean; // defaults to false
}

/**
 * WorkerOptions with all of the Worker required attributes
 */
export type WorkerOptionsWithDefaults = WorkerOptions &
  Required<
    Pick<
      WorkerOptions,
      | 'namespace'
      | 'shutdownGraceTime'
      | 'maxConcurrentActivityTaskExecutions'
      | 'maxConcurrentWorkflowTaskExecutions'
      | 'maxConcurrentActivityTaskPolls'
      | 'maxConcurrentWorkflowTaskPolls'
      | 'nonStickyToStickyPollRatio'
      | 'stickyQueueScheduleToStartTimeout'
      | 'maxCachedWorkflows'
      | 'maxHeartbeatThrottleInterval'
      | 'defaultHeartbeatThrottleInterval'
      | 'enableSDKTracing'
      | 'debugMode'
    >
  > & {
    /**
     * Controls the number of Worker threads the Worker should create.
     *
     * Threads are used to create [vm](https://nodejs.org/api/vm.html)s for the
     *
     * isolated Workflow environment.
     *
     * New Workflows are created on this pool in a round-robin fashion.
     *
     * This value is not exposed at the moment.
     *
     * @default 8
     */
    workflowThreadPoolSize: number;

    /**
     * Time to wait for result when calling a Workflow isolate function.
     * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
     *
     * This value is not exposed at the moment.
     *
     * @default 5s
     */
    isolateExecutionTimeout: string | number;
  };

/**
 * {@link WorkerOptions} where the attributes the Worker requires are required and time units are converted from ms formatted strings to numbers.
 */
export interface CompiledWorkerOptions extends Omit<WorkerOptionsWithDefaults, 'serverOptions'> {
  shutdownGraceTimeMs: number;
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
    | 'maxConcurrentActivityTaskPolls'
    | 'maxHeartbeatThrottleInterval'
    | 'defaultHeartbeatThrottleInterval'
    | 'debugMode'
  > {
  /**
   *  A name for this replay worker. It will be combined with a short random ID to form a unique
   *  task queue for the replay worker.
   */
  replayName: string;
}

export function addDefaultWorkerOptions(options: WorkerOptions): WorkerOptionsWithDefaults {
  const { maxCachedWorkflows, debugMode, ...rest } = options;
  return {
    namespace: 'default',
    shutdownGraceTime: '5s',
    maxConcurrentActivityTaskExecutions: 100,
    maxConcurrentWorkflowTaskExecutions: 100,
    maxConcurrentActivityTaskPolls: 5,
    maxConcurrentWorkflowTaskPolls: 5,
    nonStickyToStickyPollRatio: 0.2,
    stickyQueueScheduleToStartTimeout: '10s',
    maxHeartbeatThrottleInterval: '60s',
    defaultHeartbeatThrottleInterval: '30s',
    // 4294967295ms is the maximum allowed time
    isolateExecutionTimeout: debugMode ? '4294967295ms' : '5s',
    workflowThreadPoolSize: 8,
    maxCachedWorkflows: maxCachedWorkflows ?? Math.max(os.totalmem() / GiB - 1, 1) * 200,
    enableSDKTracing: false,
    debugMode: debugMode ?? false,
    ...rest,
  };
}

export function compileWorkerOptions(opts: WorkerOptionsWithDefaults): CompiledWorkerOptions {
  return {
    ...opts,
    shutdownGraceTimeMs: msToNumber(opts.shutdownGraceTime),
    stickyQueueScheduleToStartTimeoutMs: msToNumber(opts.stickyQueueScheduleToStartTimeout),
    isolateExecutionTimeoutMs: msToNumber(opts.isolateExecutionTimeout),
    maxHeartbeatThrottleIntervalMs: msToNumber(opts.maxHeartbeatThrottleInterval),
    defaultHeartbeatThrottleIntervalMs: msToNumber(opts.defaultHeartbeatThrottleInterval),
    loadedDataConverter: loadDataConverter(opts.dataConverter),
  };
}
