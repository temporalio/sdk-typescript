import { DataConverter, LoadedDataConverter } from '@temporalio/common';
import { loadDataConverter } from '@temporalio/internal-non-workflow-common';
import { msToNumber } from '@temporalio/internal-workflow-common';
import { ActivityInboundLogInterceptor } from './activity-log-interceptor';
import { NativeConnection } from './connection';
import { WorkerInterceptors } from './interceptors';
import { Runtime } from './runtime';
import { InjectedSinks } from './sinks';
import { GiB } from './utils';
import { LoggerSinks } from './workflow-log-interceptor';
import { WorkflowBundleWithSourceMap } from './workflow/bundler';
import * as v8 from 'v8';
import * as fs from 'fs';
import * as os from 'os';

export interface WorkflowBundlePathWithSourceMap {
  codePath: string;
  sourceMapPath: string;
}
export type WorkflowBundleOption = WorkflowBundleWithSourceMap | WorkflowBundlePathWithSourceMap;

export function isCodeBundleOption(bundleOpt: WorkflowBundleOption): bundleOpt is WorkflowBundleWithSourceMap {
  const opt = bundleOpt as any; // Cast to access properties without TS complaining
  return typeof opt.code === 'string' && typeof opt.sourceMap === 'string';
}

export function isPathBundleOption(bundleOpt: WorkflowBundleOption): bundleOpt is WorkflowBundlePathWithSourceMap {
  const opt = bundleOpt as any; // Cast to access properties without TS complaining
  return typeof opt.codePath === 'string' && opt.sourceMapPath;
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
   * Use a pre-built bundle for Workflow code.
   * Use {@link bundleWorkflowCode} to genrate a bundle.
   *
   * This is the recommended way to deploy Workers to production.
   *
   * See https://docs.temporal.io/typescript/production-deploy#pre-build-code for more information.
   */
  workflowBundle?: WorkflowBundleOption;

  /**
   * Time to wait for pending tasks to drain after shutdown was requested.
   *
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   * @default 10s
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
   * Limits the number of activities per second that this worker will process. The worker will
   * not poll for new activities if by doing so it might receive and execute an activity which
   * would cause it to exceed this limit. Must be a positive floating point number.
   *
   * If unset, no rate limiting will be applied to Worker's activities.
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
   * Most users are able to fit 250 Workflows per GB of available memory (this depends on your Workflow bundle size).
   * For the SDK test Workflows, we managed to fit 750 Workflows per GB.
   *
   * @default `max((systemMemory - maxHeapMemory) / 1GiB - 1, 1) * 250`
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
   * A mapping of interceptor type to a list of factories or module paths.
   *
   * By default {@link ActivityInboundLogInterceptor} and {@link WorkflowInboundLogInterceptor} are installed.
   *
   * If you wish to customize the interceptors while keeping the defaults, use {@link appendDefaultInterceptors}.
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
      | 'debugMode'
    >
  > & {
    /**
     * Controls the number of Worker threads the Worker should create.
     *
     * Threads are used to create {@link https://nodejs.org/api/vm.html | vm }s for the
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
    | 'maxConcurrentLocalActivityExecutions'
    | 'maxConcurrentWorkflowTaskExecutions'
    | 'maxHeartbeatThrottleInterval'
    | 'defaultHeartbeatThrottleInterval'
    | 'debugMode'
  > {
  /**
   *  A name for this replay worker. It will be combined with a short random ID to form a unique
   *  task queue for the replay worker.
   *
   *  @default workflow name from given history
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
    workflowModules: [...(interceptors.workflowModules ?? []), require.resolve('./workflow-log-interceptor')],
  };
}

export function addDefaultWorkerOptions(options: WorkerOptions): WorkerOptionsWithDefaults {
  const { maxCachedWorkflows, debugMode, ...rest } = options;

  const defaults = calculateDefaultWorkerOptions();

  const optionsWithDefaults = {
    namespace: 'default',
    identity: `${process.pid}@${os.hostname()}`,
    shutdownGraceTime: '10s',
    maxConcurrentActivityTaskExecutions: 100,
    maxConcurrentLocalActivityExecutions: 100,
    enableNonLocalActivities: true,
    maxConcurrentWorkflowTaskExecutions: 100,
    stickyQueueScheduleToStartTimeout: '10s',
    maxHeartbeatThrottleInterval: '60s',
    defaultHeartbeatThrottleInterval: '30s',
    // 4294967295ms is the maximum allowed time
    isolateExecutionTimeout: debugMode ? '4294967295ms' : '5s',
    workflowThreadPoolSize: 8,
    maxCachedWorkflows: maxCachedWorkflows ?? defaults.maxCachedWorkflows,
    enableSDKTracing: false,
    debugMode: debugMode ?? false,
    interceptors: appendDefaultInterceptors({}),
    sinks: defaultSinks(),
    ...rest,
  };

  reportWorkerOptions(optionsWithDefaults);

  return optionsWithDefaults;
}

export function calculateDefaultWorkerOptions(): { maxCachedWorkflows: number } {
  const systemResources = inspectSystemResources();

  const heapSizeLimit = v8.getHeapStatistics().heap_size_limit;
  if (heapSizeLimit > systemResources.memory * 0.5) {
    Runtime.instance().logger.warn(
      `node's heap size limit is over 50% of available memory (heapSizeLimit = ${heapSizeLimit}, systemMemory = ${systemResources.memory})`
    );
    Runtime.instance().logger.warn(`This might degrade performances and could result in OOM errors.`);
    Runtime.instance().logger.warn(
      `For optimal performance, try setting '--max-old-space-size' between 25% and 50% of system memory.`
    );
  }

  return {
    maxCachedWorkflows: Math.floor(
      Math.max((systemResources.memory + systemResources.swap - heapSizeLimit) / GiB - 1, 1) * 250
    ),
  };
}

/**
 * Inspect the execution environment and return information about available system resources,
 * taking into account applicable constraints that can be discovered.
 * At present, it accounts for CGroups v1 and v2 constraints on memory and swap.
 */
export function inspectSystemResources(): { memory: number; swap: number } {
  const systemMemory = os.totalmem();

  const limits = {
    memory: systemMemory,
    swap: 0,
  };

  if (process.platform === 'linux') {
    // Check for v2 style cgroups
    if (fs.existsSync('/sys/fs/cgroup/cgroup.controllers')) {
      // Maximum size (in bytes) of memory usage allowed by this container. 'max' if no constraint.
      // Examples:
      //  - 536870912 => 512 Mb
      //  - max => no constraint
      const memoryMax = tryReadFileSync('/sys/fs/cgroup/memory.max');
      if (isNumber(memoryMax)) limits.memory = Math.min(Number(memoryMax), limits.memory);

      // Maximum size (in bytes) of swap usage allowed by this container. The reported size EXCLUDES the size of memory itself.
      // For example, assuming `docker run --memory 512mb --memory-swap 768mb`, memory.swap.max will report 256mb
      // Defaults to one time the size of maximum memory (if constrained), or 'max' if no constraint on memory
      //
      // Examples:
      //  - 268435456 => 256 Mb
      //  - max => no constraint
      const swapMax = tryReadFileSync('/sys/fs/cgroup/memory.swap.max');
      // For heuristics, don't use more than one time the RAM in swap
      if (isNumber(swapMax)) limits.swap = Math.min(Number(swapMax), systemMemory);
    }

    // Check for v1 style cgroups: /sys/fs/cgroup/memory/memory.limit_in_bytes
    if (fs.existsSync('/sys/fs/cgroup/memory/memory.limit_in_bytes')) {
      // Maximum size (in bytes) of memory usage allowed by this container. '9223372036854771712' if no constraint
      // Examples:
      //  - 536870912 => 512 Mb
      //  - 9223372036854771712 => no constraint
      const memoryMax = tryReadFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes');
      if (isNumber(memoryMax)) limits.memory = Math.min(Number(memoryMax), limits.memory);

      // Maximum size (in bytes) of swap usage allowed by this container. The reported size INCLUDES the size of memory itself.
      // For example, assuming `docker run --memory 512mb --memory-swap 768mb`, memory.memsw.limit_in_bytes will report 768mb.
      // File might also not exists if system does not support swap.
      // Defaults to '9223372036854771712' if no constraint.
      // Examples:
      //  - 536870912 => 512 Mb
      //  - 9223372036854771712 => no constraint
      const swapMax = tryReadFileSync('/sys/fs/cgroup/memory/memory.memsw.limit_in_bytes');
      if (isNumber(swapMax)) limits.swap = Math.min(Number(swapMax) - limits.memory, systemMemory);
    }
  }

  return limits;
}

function tryReadFileSync(file: string) {
  try {
    return fs.readFileSync(file, { encoding: 'ascii' }) as string;
  } catch (e) {
    return undefined;
  }
}

function isNumber(s: string | undefined) {
  return s && /^\d+$/.test(s);
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

function reportWorkerOptions(options: WorkerOptionsWithDefaults) {
  Runtime.instance().logger.info(`Worker options:`);
  Runtime.instance().logger.info(
    JSON.stringify(
      {
        ...options,
        ...(options.workflowBundle && isCodeBundleOption(options.workflowBundle)
          ? {
              // Avoid dumping workflow bundle code to the console
              workflowBundle: <WorkflowBundleWithSourceMap>{
                code: `<string of length ${options.workflowBundle.code.length}>`,
                sourceMap: `<string of length ${options.workflowBundle.sourceMap.length}>`,
              },
            }
          : {}),
      },
      undefined,
      2
    )
  );
}
