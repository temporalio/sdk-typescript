import type { RawSourceMap } from 'source-map';
import {
  RetryPolicy,
  TemporalFailure,
  CommonWorkflowOptions,
  SearchAttributes,
  SignalDefinition,
  QueryDefinition,
} from '@temporalio/common';
import { checkExtends } from '@temporalio/common/lib/type-helpers';
import type { coresdk } from '@temporalio/proto';

/**
 * Workflow Execution information
 */
export interface WorkflowInfo {
  /**
   * ID of the Workflow, this can be set by the client during Workflow creation.
   * A single Workflow may run multiple times e.g. when scheduled with cron.
   */
  workflowId: string;

  /**
   * ID of a single Workflow run
   */
  runId: string;

  /**
   * Workflow function's name
   */
  workflowType: string;

  /**
   * Indexed information attached to the Workflow Execution
   *
   * This value may change during the lifetime of an Execution.
   */
  searchAttributes: SearchAttributes;

  /**
   * Non-indexed information attached to the Workflow Execution
   */
  memo?: Record<string, unknown>;

  /**
   * Parent Workflow info (present if this is a Child Workflow)
   */
  parent?: ParentWorkflowInfo;

  /**
   * Result from the previous Run (present if this is a Cron Workflow or was Continued As New).
   *
   * An array of values, since other SDKs may return multiple values from a Workflow.
   */
  lastResult?: unknown;

  /**
   * Failure from the previous Run (present when this Run is a retry, or the last Run of a Cron Workflow failed)
   */
  lastFailure?: TemporalFailure;

  /**
   * Length of Workflow history up until the current Workflow Task.
   *
   * This value changes during the lifetime of an Execution.
   *
   * You may safely use this information to decide when to {@link continueAsNew}.
   */
  historyLength: number;

  /**
   * Task queue this Workflow is executing on
   */
  taskQueue: string;

  /**
   * Namespace this Workflow is executing in
   */
  namespace: string;

  /**
   * Run Id of the first Run in this Execution Chain
   */
  firstExecutionRunId: string;

  /**
   * The last Run Id in this Execution Chain
   */
  continuedFromExecutionRunId?: string;

  /**
   * Time at which this [Workflow Execution Chain](https://docs.temporal.io/workflows#workflow-execution-chain) was started
   */
  startTime: Date;

  /**
   * Time at which the current Workflow Run started
   */
  runStartTime: Date;

  /**
   * Milliseconds after which the Workflow Execution is automatically terminated by Temporal Server. Set via {@link WorkflowOptions.workflowExecutionTimeout}.
   */
  executionTimeoutMs?: number;

  /**
   * Time at which the Workflow Execution expires
   */
  executionExpirationTime?: Date;

  /**
   * Milliseconds after which the Workflow Run is automatically terminated by Temporal Server. Set via {@link WorkflowOptions.workflowRunTimeout}.
   */
  runTimeoutMs?: number;

  /**
   * Maximum execution time of a Workflow Task in milliseconds. Set via {@link WorkflowOptions.workflowTaskTimeout}.
   */
  taskTimeoutMs: number;

  /**
   * Retry Policy for this Execution. Set via {@link WorkflowOptions.retry}.
   */
  retryPolicy?: RetryPolicy;

  /**
   * Starts at 1 and increments for every retry if there is a `retryPolicy`
   */
  attempt: number;

  /**
   * Cron Schedule for this Execution. Set via {@link WorkflowOptions.cronSchedule}.
   */
  cronSchedule?: string;

  /**
   * Milliseconds between Cron Runs
   */
  cronScheduleToScheduleInterval?: number;

  unsafe: UnsafeWorkflowInfo;
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
  now(): number;

  isReplaying: boolean;
}

export interface ParentWorkflowInfo {
  workflowId: string;
  runId: string;
  namespace: string;
}

/**
 * Not an actual error, used by the Workflow runtime to abort execution when {@link continueAsNew} is called
 */
export class ContinueAsNew extends Error {
  public readonly name = 'ContinueAsNew';

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
  workflowRunTimeout?: string;
  /**
   * Timeout for a single Workflow task
   * @format {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  workflowTaskTimeout?: string;
  /**
   * Non-searchable attributes to attach to next Workflow run
   */
  memo?: Record<string, unknown>;
  /**
   * Searchable attributes to attach to next Workflow run
   */
  searchAttributes?: SearchAttributes;
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
}

export type RequiredChildWorkflowOptions = Required<Pick<ChildWorkflowOptions, 'workflowId' | 'cancellationType'>> & {
  args: unknown[];
};

export type ChildWorkflowOptionsWithDefaults = ChildWorkflowOptions & RequiredChildWorkflowOptions;

export interface SDKInfo {
  name: string;
  version: string;
}

/**
 * Represents a slice of a file starting at lineOffset
 */
export interface FileSlice {
  /**
   * slice of a file with `\n` (newline) line terminator.
   */
  content: string;
  /**
   * Only used possible to trim the file without breaking syntax highlighting.
   */
  lineOffset: number;
}

/**
 * A pointer to a location in a file
 */
export interface FileLocation {
  /**
   * Path to source file (absolute or relative).
   * When using a relative path, make sure all paths are relative to the same root.
   */
  filePath?: string;
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
  functionName?: string;
}

export interface StackTrace {
  locations: FileLocation[];
}

/**
 * Used as the result for the enhanced stack trace query
 */
export interface EnhancedStackTrace {
  sdk: SDKInfo;
  /**
   * Mapping of file path to file contents.
   * SDK may choose to send no, some or all sources.
   * Sources might be trimmed, and some time only the file(s) of the top element of the trace will be sent.
   */
  sources: Record<string, FileSlice[]>;
  stacks: StackTrace[];
}

export interface WorkflowCreateOptions {
  info: WorkflowInfo;
  randomnessSeed: number[];
  now: number;
  patches: string[];
  showStackTraceSources: boolean;
}

export interface WorkflowCreateOptionsWithSourceMap extends WorkflowCreateOptions {
  sourceMap: RawSourceMap;
}

/**
 * A handler function capable of accepting the arguments for a given SignalDefinition or QueryDefinition.
 */
export type Handler<
  Ret,
  Args extends any[],
  T extends SignalDefinition<Args> | QueryDefinition<Ret, Args>
> = T extends SignalDefinition<infer A>
  ? (...args: A) => void | Promise<void>
  : T extends QueryDefinition<infer R, infer A>
  ? (...args: A) => R
  : never;

/**
 * A handler function accepting signals calls for non-registered signal names.
 */
export type DefaultSignalHandler = (signalName: string, ...args: unknown[]) => void | Promise<void>;
