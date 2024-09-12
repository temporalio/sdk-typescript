import type { RawSourceMap } from 'source-map';
import {
  RetryPolicy,
  TemporalFailure,
  CommonWorkflowOptions,
  HandlerUnfinishedPolicy,
  SearchAttributes,
  SignalDefinition,
  UpdateDefinition,
  QueryDefinition,
  Duration,
  VersioningIntent,
} from '@temporalio/common';
import { checkExtends, SymbolBasedInstanceOfError } from '@temporalio/common/lib/type-helpers';
import type { coresdk } from '@temporalio/proto';

/**
 * Workflow Execution information
 */
export interface WorkflowInfo {
  /**
   * ID of the Workflow, this can be set by the client during Workflow creation.
   * A single Workflow may run multiple times e.g. when scheduled with cron.
   */
  readonly workflowId: string;

  /**
   * ID of a single Workflow run
   */
  readonly runId: string;

  /**
   * Workflow function's name
   */
  readonly workflowType: string;

  /**
   * Indexed information attached to the Workflow Execution
   *
   * This value may change during the lifetime of an Execution.
   */
  readonly searchAttributes: SearchAttributes;

  /**
   * Non-indexed information attached to the Workflow Execution
   */
  readonly memo?: Record<string, unknown>;

  /**
   * Parent Workflow info (present if this is a Child Workflow)
   */
  readonly parent?: ParentWorkflowInfo;

  /**
   * Result from the previous Run (present if this is a Cron Workflow or was Continued As New).
   *
   * An array of values, since other SDKs may return multiple values from a Workflow.
   */
  readonly lastResult?: unknown;

  /**
   * Failure from the previous Run (present when this Run is a retry, or the last Run of a Cron Workflow failed)
   */
  readonly lastFailure?: TemporalFailure;

  /**
   * Length of Workflow history up until the current Workflow Task.
   *
   * This value changes during the lifetime of an Execution.
   *
   * You may safely use this information to decide when to {@link continueAsNew}.
   */
  readonly historyLength: number;

  /**
   * Size of Workflow history in bytes until the current Workflow Task.
   *
   * This value changes during the lifetime of an Execution.
   *
   * Supported only on Temporal Server 1.20+, always zero on older servers.
   *
   * You may safely use this information to decide when to {@link continueAsNew}.
   */
  readonly historySize: number;

  /**
   * A hint provided by the current WorkflowTaskStarted event recommending whether to
   * {@link continueAsNew}.
   *
   * This value changes during the lifetime of an Execution.
   *
   * Supported only on Temporal Server 1.20+, always `false` on older servers.
   */
  readonly continueAsNewSuggested: boolean;

  /**
   * Task queue this Workflow is executing on
   */
  readonly taskQueue: string;

  /**
   * Namespace this Workflow is executing in
   */
  readonly namespace: string;

  /**
   * Run Id of the first Run in this Execution Chain
   */
  readonly firstExecutionRunId: string;

  /**
   * The last Run Id in this Execution Chain
   */
  readonly continuedFromExecutionRunId?: string;

  /**
   * Time at which this [Workflow Execution Chain](https://docs.temporal.io/workflows#workflow-execution-chain) was started
   */
  readonly startTime: Date;

  /**
   * Time at which the current Workflow Run started
   */
  readonly runStartTime: Date;

  /**
   * Milliseconds after which the Workflow Execution is automatically terminated by Temporal Server. Set via {@link WorkflowOptions.workflowExecutionTimeout}.
   */
  readonly executionTimeoutMs?: number;

  /**
   * Time at which the Workflow Execution expires
   */
  readonly executionExpirationTime?: Date;

  /**
   * Milliseconds after which the Workflow Run is automatically terminated by Temporal Server. Set via {@link WorkflowOptions.workflowRunTimeout}.
   */
  readonly runTimeoutMs?: number;

  /**
   * Maximum execution time of a Workflow Task in milliseconds. Set via {@link WorkflowOptions.workflowTaskTimeout}.
   */
  readonly taskTimeoutMs: number;

  /**
   * Retry Policy for this Execution. Set via {@link WorkflowOptions.retry}.
   */
  readonly retryPolicy?: RetryPolicy;

  /**
   * Starts at 1 and increments for every retry if there is a `retryPolicy`
   */
  readonly attempt: number;

  /**
   * Cron Schedule for this Execution. Set via {@link WorkflowOptions.cronSchedule}.
   */
  readonly cronSchedule?: string;

  /**
   * Milliseconds between Cron Runs
   */
  readonly cronScheduleToScheduleInterval?: number;

  /**
   * The Build ID of the worker which executed the current Workflow Task. May be undefined if the
   * task was completed by a worker without a Build ID. If this worker is the one executing this
   * task for the first time and has a Build ID set, then its ID will be used. This value may change
   * over the lifetime of the workflow run, but is deterministic and safe to use for branching.
   */
  readonly currentBuildId?: string;

  readonly unsafe: UnsafeWorkflowInfo;
}

/**
 * Unsafe information about the current Workflow Execution.
 *
 * Never rely on this information in Workflow logic as it will cause non-deterministic behavior.
 */
export interface UnsafeWorkflowInfo {
  /**
   * Current system time in milliseconds
   *
   * The safe version of time is `new Date()` and `Date.now()`, which are set on the first invocation of a Workflow
   * Task and stay constant for the duration of the Task and during replay.
   */
  readonly now: () => number;

  readonly isReplaying: boolean;
}

/**
 * Information about a workflow update.
 *
 * @experimental
 */
export interface UpdateInfo {
  /**
   *  A workflow-unique identifier for this update.
   */
  readonly id: string;

  /**
   *  The update type name.
   */
  readonly name: string;
}

export interface ParentWorkflowInfo {
  workflowId: string;
  runId: string;
  namespace: string;
}

/**
 * Not an actual error, used by the Workflow runtime to abort execution when {@link continueAsNew} is called
 */
@SymbolBasedInstanceOfError('ContinueAsNew')
export class ContinueAsNew extends Error {
  constructor(public readonly command: coresdk.workflow_commands.IContinueAsNewWorkflowExecution) {
    super('Workflow continued as new');
  }
}

/**
 * Options for continuing a Workflow as new
 */
export interface ContinueAsNewOptions {
  /**
   * A string representing the Workflow type name, e.g. the filename in the Node.js SDK or class name in Java
   */
  workflowType?: string;
  /**
   * Task queue to continue the Workflow in
   */
  taskQueue?: string;
  /**
   * Timeout for the entire Workflow run
   * @format {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  workflowRunTimeout?: Duration;
  /**
   * Timeout for a single Workflow task
   * @format {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  workflowTaskTimeout?: Duration;
  /**
   * Non-searchable attributes to attach to next Workflow run
   */
  memo?: Record<string, unknown>;
  /**
   * Searchable attributes to attach to next Workflow run
   */
  searchAttributes?: SearchAttributes;
  /**
   * When using the Worker Versioning feature, specifies whether this Workflow should
   * Continue-as-New onto a worker with a compatible Build Id or not. See {@link VersioningIntent}.
   *
   * @default 'COMPATIBLE'
   *
   * @experimental
   */
  versioningIntent?: VersioningIntent;
}

/**
 * Specifies:
 * - whether cancellation requests are sent to the Child
 * - whether and when a {@link CanceledFailure} is thrown from {@link executeChild} or
 *   {@link ChildWorkflowHandle.result}
 *
 * @default {@link ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED}
 */
export enum ChildWorkflowCancellationType {
  /**
   * Don't send a cancellation request to the Child.
   */
  ABANDON = 0,

  /**
   * Send a cancellation request to the Child. Immediately throw the error.
   */
  TRY_CANCEL = 1,

  /**
   * Send a cancellation request to the Child. The Child may respect cancellation, in which case an error will be thrown
   * when cancellation has completed, and {@link isCancellation}(error) will be true. On the other hand, the Child may
   * ignore the cancellation request, in which case an error might be thrown with a different cause, or the Child may
   * complete successfully.
   *
   * @default
   */
  WAIT_CANCELLATION_COMPLETED = 2,

  /**
   * Send a cancellation request to the Child. Throw the error once the Server receives the Child cancellation request.
   */
  WAIT_CANCELLATION_REQUESTED = 3,
}

checkExtends<coresdk.child_workflow.ChildWorkflowCancellationType, ChildWorkflowCancellationType>();
checkExtends<ChildWorkflowCancellationType, coresdk.child_workflow.ChildWorkflowCancellationType>();

/**
 * How a Child Workflow reacts to the Parent Workflow reaching a Closed state.
 *
 * @see {@link https://docs.temporal.io/concepts/what-is-a-parent-close-policy/ | Parent Close Policy}
 */
export enum ParentClosePolicy {
  /**
   * If a `ParentClosePolicy` is set to this, or is not set at all, the server default value will be used.
   */
  PARENT_CLOSE_POLICY_UNSPECIFIED = 0,

  /**
   * When the Parent is Closed, the Child is Terminated.
   *
   * @default
   */
  PARENT_CLOSE_POLICY_TERMINATE = 1,

  /**
   * When the Parent is Closed, nothing is done to the Child.
   */
  PARENT_CLOSE_POLICY_ABANDON = 2,

  /**
   * When the Parent is Closed, the Child is Cancelled.
   */
  PARENT_CLOSE_POLICY_REQUEST_CANCEL = 3,
}

checkExtends<coresdk.child_workflow.ParentClosePolicy, ParentClosePolicy>();
checkExtends<ParentClosePolicy, coresdk.child_workflow.ParentClosePolicy>();

export interface ChildWorkflowOptions extends CommonWorkflowOptions {
  /**
   * Workflow id to use when starting. If not specified a UUID is generated. Note that it is
   * dangerous as in case of client side retries no deduplication will happen based on the
   * generated id. So prefer assigning business meaningful ids if possible.
   */
  workflowId?: string;

  /**
   * Task queue to use for Workflow tasks. It should match a task queue specified when creating a
   * `Worker` that hosts the Workflow code.
   */
  taskQueue?: string;

  /**
   * Specifies:
   * - whether cancellation requests are sent to the Child
   * - whether and when an error is thrown from {@link executeChild} or
   *   {@link ChildWorkflowHandle.result}
   *
   * @default {@link ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED}
   */
  cancellationType?: ChildWorkflowCancellationType;

  /**
   * Specifies how the Child reacts to the Parent Workflow reaching a Closed state.
   *
   * @default {@link ParentClosePolicy.PARENT_CLOSE_POLICY_TERMINATE}
   */
  parentClosePolicy?: ParentClosePolicy;

  /**
   * When using the Worker Versioning feature, specifies whether this Child Workflow should run on
   * a worker with a compatible Build Id or not. See {@link VersioningIntent}.
   *
   * @default 'COMPATIBLE'
   *
   * @experimental
   */
  versioningIntent?: VersioningIntent;
}

export type RequiredChildWorkflowOptions = Required<Pick<ChildWorkflowOptions, 'workflowId' | 'cancellationType'>> & {
  args: unknown[];
};

export type ChildWorkflowOptionsWithDefaults = ChildWorkflowOptions & RequiredChildWorkflowOptions;

export interface StackTraceSDKInfo {
  name: string;
  version: string;
}

/**
 * Represents a slice of a file starting at lineOffset
 */
export interface StackTraceFileSlice {
  /**
   * Only used possible to trim the file without breaking syntax highlighting.
   */
  line_offset: number;
  /**
   * slice of a file with `\n` (newline) line terminator.
   */
  content: string;
}

/**
 * A pointer to a location in a file
 */
export interface StackTraceFileLocation {
  /**
   * Path to source file (absolute or relative).
   * When using a relative path, make sure all paths are relative to the same root.
   */
  file_path?: string;
  /**
   * If possible, SDK should send this, required for displaying the code location.
   */
  line?: number;
  /**
   * If possible, SDK should send this.
   */
  column?: number;
  /**
   * Function name this line belongs to (if applicable).
   * Used for falling back to stack trace view.
   */
  function_name?: string;
  /**
   * Flag to mark this as internal SDK code and hide by default in the UI.
   */
  internal_code: boolean;
}

export interface StackTrace {
  locations: StackTraceFileLocation[];
}

/**
 * Used as the result for the enhanced stack trace query
 */
export interface EnhancedStackTrace {
  sdk: StackTraceSDKInfo;
  /**
   * Mapping of file path to file contents.
   * SDK may choose to send no, some or all sources.
   * Sources might be trimmed, and some time only the file(s) of the top element of the trace will be sent.
   */
  sources: Record<string, StackTraceFileSlice[]>;
  stacks: StackTrace[];
}

export interface WorkflowCreateOptions {
  info: WorkflowInfo;
  randomnessSeed: number[];
  now: number;
  showStackTraceSources: boolean;
}

export interface WorkflowCreateOptionsInternal extends WorkflowCreateOptions {
  sourceMap: RawSourceMap;
  registeredActivityNames: Set<string>;
  getTimeOfDay(): bigint;
}

/**
 * A handler function capable of accepting the arguments for a given UpdateDefinition, SignalDefinition or QueryDefinition.
 */
export type Handler<
  Ret,
  Args extends any[],
  T extends UpdateDefinition<Ret, Args> | SignalDefinition<Args> | QueryDefinition<Ret, Args>,
> = T extends UpdateDefinition<infer R, infer A>
  ? (...args: A) => R | Promise<R>
  : T extends SignalDefinition<infer A>
    ? (...args: A) => void | Promise<void>
    : T extends QueryDefinition<infer R, infer A>
      ? (...args: A) => R
      : never;

/**
 * A handler function accepting signal calls for non-registered signal names.
 */
export type DefaultSignalHandler = (signalName: string, ...args: unknown[]) => void | Promise<void>;

/**
 * A validation function capable of accepting the arguments for a given UpdateDefinition.
 */
export type UpdateValidator<Args extends any[]> = (...args: Args) => void;

/**
 * A description of a query handler.
 */
export type QueryHandlerOptions = { description?: string };

/**
 * A description of a signal handler.
 */
export type SignalHandlerOptions = { description?: string; unfinishedPolicy?: HandlerUnfinishedPolicy };

/**
 * A validator and description of an update handler.
 */
export type UpdateHandlerOptions<Args extends any[]> = {
  validator?: UpdateValidator<Args>;
  description?: string;
  unfinishedPolicy?: HandlerUnfinishedPolicy;
};

export interface ActivationCompletion {
  commands: coresdk.workflow_commands.IWorkflowCommand[];
  usedInternalFlags: number[];
}
