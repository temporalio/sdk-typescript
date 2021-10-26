import os from 'os';
import fs from 'fs';
import { resolve, dirname } from 'path';
import { ActivityInterface, DataConverter, defaultDataConverter, msToNumber } from '@temporalio/common';
import { WorkerInterceptors } from './interceptors';
import { InjectedDependencies } from './dependencies';
import { GiB, MiB } from './utils';

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
   */
  workflowsPath?: string;

  /**
   * Use a pre-built bundle for Workflow code.
   * Use {@link bundleWorkflowCode} to genrate a bundle.
   *
   * This is the recommended way to deploy Workers to production.
   */
  workflowBundle?: WorkflowBundle;

  /**
   * Path for webpack to look up modules in for bundling the Workflow code.
   * Automatically discovered if {@link workflowsPath} is provided.
   */
  nodeModulesPaths?: string[];

  /**
   * Time to wait for pending tasks to drain after shutdown was requested.
   *
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   */
  shutdownGraceTime?: string | number;

  /**
   * Automatically shut down worker on any of these signals.
   * @default
   * ```ts
   * ['SIGINT', 'SIGTERM', 'SIGQUIT']
   * ```
   */
  shutdownSignals?: NodeJS.Signals[];

  /**
   * TODO: document, figure out how to propagate this to the workflow isolate
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
   * Time to wait for result when calling a Workflow isolate function.
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   * @default 5s
   */
  isolateExecutionTimeout?: string | number;

  /**
   * Memory limit in MB for the Workflow v8 isolate.
   *
   * If this limit is exceeded the isolate will be disposed and the worker will crash.
   *
   * @default `max(os.totalmem() - 1GiB, 1GiB)`
   */
  maxIsolateMemoryMB?: number;

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
   * Controls the number of v8 isolates the Worker should create.
   *
   * New Workflows are created on this pool in a round-robin fashion.
   *
   * @default 8
   */
  isolatePoolSize?: number;

  /**
   * A mapping of interceptor type to a list of factories or module paths
   */
  interceptors?: WorkerInterceptors;
  // TODO: implement all of these
  // maxConcurrentLocalActivityExecutions?: number; // defaults to 200
  // maxTaskQueueActivitiesPerSecond?: number;
  // maxWorkerActivitiesPerSecond?: number;
  // isLocalActivityWorkerOnly?: boolean; // defaults to false
  dependencies?: InjectedDependencies<any>;
}

/**
 * WorkerOptions with all of the Worker required attributes
 */
export type WorkerOptionsWithDefaults = WorkerOptions &
  Required<
    Pick<
      WorkerOptions,
      | 'shutdownGraceTime'
      | 'shutdownSignals'
      | 'dataConverter'
      | 'maxConcurrentActivityTaskExecutions'
      | 'maxConcurrentWorkflowTaskExecutions'
      | 'maxConcurrentActivityTaskPolls'
      | 'maxConcurrentWorkflowTaskPolls'
      | 'nonStickyToStickyPollRatio'
      | 'stickyQueueScheduleToStartTimeout'
      | 'isolateExecutionTimeout'
      | 'maxIsolateMemoryMB'
      | 'maxCachedWorkflows'
      | 'isolatePoolSize'
    >
  >;

/**
 * {@link WorkerOptions} where the attributes the Worker requires are required and time units are converted from ms formatted strings to numbers.
 */
export interface CompiledWorkerOptions extends Omit<WorkerOptionsWithDefaults, 'serverOptions'> {
  shutdownGraceTimeMs: number;
  isolateExecutionTimeoutMs: number;
  stickyQueueScheduleToStartTimeoutMs: number;
}

function statIfExists(filesystem: typeof fs, path: string): fs.Stats | undefined {
  try {
    return filesystem.statSync(path);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
  return undefined;
}

export function resolveNodeModulesPaths(filesystem: typeof fs, workflowsPath: string): string[] {
  let currentDir = workflowsPath;
  const stat = filesystem.statSync(workflowsPath);
  if (stat.isFile()) {
    currentDir = dirname(currentDir);
  }
  for (;;) {
    const candidate = resolve(currentDir, 'node_modules');
    const stat = statIfExists(filesystem, candidate);
    if (stat?.isDirectory()) {
      return [candidate];
    }
    // Check if we've reached the FS root
    const prevDir = currentDir;
    currentDir = dirname(prevDir);
    if (currentDir === prevDir) {
      throw new Error(
        `Failed to automatically locate node_modules relative to given workflowsPath: ${workflowsPath}, pass the nodeModulesPaths Worker option to run Workflows`
      );
    }
  }
}

export function addDefaultWorkerOptions(options: WorkerOptions): WorkerOptionsWithDefaults {
  const { maxCachedWorkflows, ...rest } = options;
  return {
    nodeModulesPaths:
      options.nodeModulesPaths ??
      (options.workflowsPath ? resolveNodeModulesPaths(fs, options.workflowsPath) : undefined),
    shutdownGraceTime: '5s',
    shutdownSignals: ['SIGINT', 'SIGTERM', 'SIGQUIT'],
    dataConverter: defaultDataConverter,
    maxConcurrentActivityTaskExecutions: 100,
    maxConcurrentWorkflowTaskExecutions: 100,
    maxConcurrentActivityTaskPolls: 5,
    maxConcurrentWorkflowTaskPolls: 5,
    nonStickyToStickyPollRatio: 0.2,
    stickyQueueScheduleToStartTimeout: '10s',
    isolateExecutionTimeout: '5s',
    maxIsolateMemoryMB: Math.max(os.totalmem() - GiB, GiB) / MiB,
    isolatePoolSize: 8,
    maxCachedWorkflows: maxCachedWorkflows ?? Math.max(os.totalmem() / GiB - 1, 1) * 200,
    ...rest,
  };
}

export function compileWorkerOptions(opts: WorkerOptionsWithDefaults): CompiledWorkerOptions {
  return {
    ...opts,
    shutdownGraceTimeMs: msToNumber(opts.shutdownGraceTime),
    stickyQueueScheduleToStartTimeoutMs: msToNumber(opts.stickyQueueScheduleToStartTimeout),
    isolateExecutionTimeoutMs: msToNumber(opts.isolateExecutionTimeout),
  };
}
