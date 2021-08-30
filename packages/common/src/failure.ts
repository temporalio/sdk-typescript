import { temporal } from '@temporalio/proto';
import { DataConverter, arrayFromPayloads } from './converter/data-converter';

export const FAILURE_SOURCE = 'NodeSDK';
export type ProtoFailure = temporal.api.failure.v1.IFailure;
export type TimeoutType = temporal.api.enums.v1.TimeoutType;
export const TimeoutType = temporal.api.enums.v1.TimeoutType;
export type RetryState = temporal.api.enums.v1.RetryState;
export const RetryState = temporal.api.enums.v1.RetryState;
export type WorkflowExecution = temporal.api.common.v1.IWorkflowExecution;

/**
 * Represents failures that can cross Workflow and Activity boundaries.
 *
 * Only exceptions that extend this class will be propagated to the caller.
 *
 * **Never extend this class or any of its derivatives.** They are to be used by the SDK code
 * only. Throw an instance {@link ApplicationFailure} to pass application specific errors between
 * Workflows and Activities.
 *
 * Any unhandled exception thrown by an Activity or Workflow will be converted to an instance of
 * {@link ApplicationFailure}.
 */
export class TemporalFailure extends Error {
  public readonly name: string = 'TemporalFailure';
  /**
   * The original failure that constructed this error.
   *
   * Only present if this error was generated from an external operation.
   */
  public failure?: ProtoFailure;

  constructor(message: string | undefined, public readonly cause?: Error) {
    super(message ?? undefined);
  }
}

/** Exceptions originated at the Temporal service. */
export class ServerFailure extends TemporalFailure {
  public readonly name: string = 'ServerFailure';

  constructor(message: string | undefined, public readonly nonRetryable: boolean, cause?: Error) {
    super(message, cause);
  }
}

/**
 * Application failure is used to communicate application specific failures between Workflows and
 * Activities.
 *
 * Throw this exception to have full control over type and details if the exception delivered to
 * the caller workflow or client.
 *
 * Any unhandled exception which doesn't extend {@link TemporalFailure} is converted to an
 * instance of this class before being returned to a caller.
 *
 * The {@link type} property is used by {@link io.temporal.common.RetryOptions} to determine if
 * an instance of this exception is non retryable. Another way to avoid retrying an exception of
 * this type is by setting {@link nonRetryable} flag to `true`.
 *
 * The conversion of an exception that doesn't extend {@link TemporalFailure} to an
 * ApplicationFailure is done as following:
 *
 * - type is set to the exception full type name.
 * - message is set to the exception message
 * - nonRetryable is set to false
 * - details are set to null
 * - stack trace is copied from the original exception
 */
export class ApplicationFailure extends TemporalFailure {
  public readonly name: string = 'ApplicationFailure';

  constructor(
    message: string | undefined,
    public readonly type: string | undefined | null,
    public readonly nonRetryable: boolean,
    public readonly details?: unknown[],
    cause?: Error
  ) {
    super(message, cause);
  }

  /**
   * New ApplicationFailure with {@link nonRetryable} flag set to false. Note that this
   * exception still can be not retried by the service if its type is included into doNotRetry
   * property of the correspondent retry policy.
   *
   * @param message optional error message
   * @param type optional error type that is used by {@link RetryOptions.nonRetryableErrorTypes}.
   * @param details optional details about the failure. They are serialized using the same approach
   *     as arguments and results.
   */
  public static retryable(message: string | undefined, type: string, ...details: unknown[]): ApplicationFailure {
    return new this(message, type, false, details);
  }

  /**
   * New ApplicationFailure with {@link nonRetryable} flag set to true.
   *
   * It means that this exception is not going to be retried even if it is not included into
   * retry policy doNotRetry list.
   *
   * @param message optional error message
   * @param type optional error type
   * @param details optional details about the failure. They are serialized using the same approach
   *     as arguments and results.
   */
  public static nonRetryable(message: string | undefined, type: string, ...details: unknown[]): ApplicationFailure {
    return new this(message, type, true, details);
  }
}

/**
 * Used as the cause for when a Workflow or Activity has been cancelled
 */
export class CancelledFailure extends TemporalFailure {
  public readonly name: string = 'CancelledFailure';

  constructor(message: string | undefined, public readonly details: unknown[] = [], cause?: Error) {
    super(message, cause);
  }
}

/**
 * Used as the cause for when a Workflow has been terminated
 */
export class TerminatedFailure extends TemporalFailure {
  public readonly name: string = 'TerminatedFailure';

  constructor(message: string | undefined, cause?: Error) {
    super(message, cause);
  }
}

/**
 * Used to represent timeouts of Activities and Workflows
 */
export class TimeoutFailure extends TemporalFailure {
  public readonly name: string = 'TimeoutFailure';

  constructor(
    message: string | undefined,
    public readonly lastHeartbeatDetails: unknown,
    public readonly timeoutType: TimeoutType
  ) {
    super(message);
  }
}

/**
 * Contains information about an activity failure. Always contains the original reason for the
 * failure as its cause. For example if an activity timed out the cause is {@link TimeoutFailure}.
 *
 * This exception is expected to be thrown only by the framework code.
 */
export class ActivityFailure extends TemporalFailure {
  public constructor(
    public readonly activityType: string,
    public readonly activityId: string | undefined,
    public readonly retryState: RetryState,
    public readonly identity: string | undefined,
    cause?: Error
  ) {
    super('Activity execution failed', cause);
  }
}

/**
 * Contains information about an child workflow failure. Always contains the original reason for the
 * failure as its cause. For example if a child workflow was terminated the cause is {@link TerminatedFailure}.
 *
 * This exception is expected to be thrown only by the framework code.
 */
export class ChildWorkflowFailure extends TemporalFailure {
  public constructor(
    public readonly namespace: string | undefined,
    public readonly execution: WorkflowExecution,
    public readonly workflowType: string,
    public readonly retryState: RetryState,
    cause?: Error
  ) {
    super('Child Workflow execution failed', cause);
  }
}

/**
 * Converts an error to a Failure proto message if defined or returns undefined
 */
export async function optionalErrorToOptionalFailure(
  err: unknown,
  dataConverter: DataConverter
): Promise<ProtoFailure | undefined> {
  return err ? await errorToFailure(err, dataConverter) : undefined;
}

/**
 * Stack traces will be cutoff when on of these patterns is matched
 */
const CUTTOFF_STACK_PATTERNS = [
  /** Activity execution */
  /\s+at Activity\.execute \(.*\/worker\/(?:src|lib)\/activity\.[jt]s:\d+:\d+\)/,
  /** Workflow activation */
  /\s+at Activator\.\S+NextHandler \(webpack-internal:\/\/\/.*\/internals\.[jt]s:\d+:\d+\)/,
];

/**
 * Cuts out the framework part of a stack trace, leaving only user code entries
 */
export function cutoffStackTrace(stack?: string): string {
  const lines = (stack ?? '').split(/\r?\n/);
  const acc = Array<string>();
  lineLoop: for (const line of lines) {
    for (const pattern of CUTTOFF_STACK_PATTERNS) {
      if (pattern.test(line)) break lineLoop;
    }
    acc.push(line);
  }
  return acc.join('\n');
}

/**
 * Converts a caught error to a Failure proto message
 */
export async function errorToFailure(err: unknown, dataConverter: DataConverter): Promise<ProtoFailure> {
  if (err instanceof TemporalFailure) {
    if (err.failure) return err.failure;

    const base = {
      message: err.message,
      stackTrace: cutoffStackTrace(err.stack),
      cause: await optionalErrorToOptionalFailure(err.cause, dataConverter),
      source: FAILURE_SOURCE,
    };
    if (err instanceof ActivityFailure) {
      return {
        ...base,
        activityFailureInfo: {
          ...err,
          activityType: { name: err.activityType },
        },
      };
    }
    if (err instanceof ChildWorkflowFailure) {
      return {
        ...base,
        childWorkflowExecutionFailureInfo: {
          ...err,
          workflowExecution: err.execution,
          workflowType: { name: err.workflowType },
        },
      };
    }
    if (err instanceof ApplicationFailure) {
      return {
        ...base,
        applicationFailureInfo: {
          type: err.type,
          nonRetryable: err.nonRetryable,
          details:
            err.details && err.details.length
              ? { payloads: await dataConverter.toPayloads(...err.details) }
              : undefined,
        },
      };
    }
    if (err instanceof CancelledFailure) {
      return {
        ...base,
        canceledFailureInfo: {
          details:
            err.details && err.details.length
              ? { payloads: await dataConverter.toPayloads(...err.details) }
              : undefined,
        },
      };
    }
    if (err instanceof TimeoutFailure) {
      return {
        ...base,
        timeoutFailureInfo: {
          timeoutType: err.timeoutType,
          lastHeartbeatDetails: err.lastHeartbeatDetails
            ? { payloads: await dataConverter.toPayloads(err.lastHeartbeatDetails) }
            : undefined,
        },
      };
    }
    if (err instanceof TerminatedFailure) {
      return {
        ...base,
        terminatedFailureInfo: {},
      };
    }
    if (err instanceof ServerFailure) {
      return {
        ...base,
        serverFailureInfo: { nonRetryable: err.nonRetryable },
      };
    }
    // Just a TemporalFailure
    return base;
  }

  const base = {
    source: FAILURE_SOURCE,
  };

  if (err instanceof Error) {
    return { ...base, message: err.message ?? '', stackTrace: cutoffStackTrace(err.stack) };
  }

  if (typeof err === 'string') {
    return { ...base, message: err };
  }

  return { ...base, message: String(err) };
}

/**
 * If `err` is an Error it is turned into an `ApplicationFailure`.
 *
 * If `err` was already a `TemporalFailure`, returns the original error.
 *
 * Otherwise returns an `ApplicationFailure` with `String(err)` as the message.
 */
export function ensureTemporalFailure(err: unknown): TemporalFailure {
  if (err instanceof TemporalFailure) {
    return err;
  } else if (err instanceof Error) {
    const failure = new ApplicationFailure(err.message, err.name, false);
    failure.stack = err.stack;
    return failure;
  } else {
    const failure = new ApplicationFailure(String(err), undefined, false);
    failure.stack = '';
    return failure;
  }
}

/**
 * Converts a Failure proto message to a JS Error object if defined or returns undefined.
 */
export async function optionalFailureToOptionalError(
  failure: ProtoFailure | undefined | null,
  dataConverter: DataConverter
): Promise<TemporalFailure | undefined> {
  return failure ? await failureToError(failure, dataConverter) : undefined;
}

/**
 * Converts a Failure proto message to a JS Error object.
 *
 * Does not set common properties, that is done in {@link failureToError}.
 */
export async function failureToErrorInner(
  failure: ProtoFailure,
  dataConverter: DataConverter
): Promise<TemporalFailure> {
  if (failure.applicationFailureInfo) {
    return new ApplicationFailure(
      failure.message ?? undefined,
      failure.applicationFailureInfo.type,
      Boolean(failure.applicationFailureInfo.nonRetryable),
      await arrayFromPayloads(dataConverter, failure.applicationFailureInfo.details?.payloads),
      await optionalFailureToOptionalError(failure.cause, dataConverter)
    );
  }
  if (failure.serverFailureInfo) {
    return new ServerFailure(
      failure.message ?? undefined,
      Boolean(failure.serverFailureInfo.nonRetryable),
      await optionalFailureToOptionalError(failure.cause, dataConverter)
    );
  }
  if (failure.timeoutFailureInfo) {
    return new TimeoutFailure(
      failure.message ?? undefined,
      await dataConverter.fromPayloads(0, failure.timeoutFailureInfo.lastHeartbeatDetails?.payloads),
      failure.timeoutFailureInfo.timeoutType ?? TimeoutType.TIMEOUT_TYPE_UNSPECIFIED
    );
  }
  if (failure.terminatedFailureInfo) {
    return new TerminatedFailure(
      failure.message ?? undefined,
      await optionalFailureToOptionalError(failure.cause, dataConverter)
    );
  }
  if (failure.canceledFailureInfo) {
    return new CancelledFailure(
      failure.message ?? undefined,
      await arrayFromPayloads(dataConverter, failure.canceledFailureInfo.details?.payloads),
      await optionalFailureToOptionalError(failure.cause, dataConverter)
    );
  }
  if (failure.resetWorkflowFailureInfo) {
    return new ApplicationFailure(
      failure.message ?? undefined,
      'ResetWorkflow',
      false,
      await arrayFromPayloads(dataConverter, failure.resetWorkflowFailureInfo.lastHeartbeatDetails?.payloads),
      await optionalFailureToOptionalError(failure.cause, dataConverter)
    );
  }
  if (failure.childWorkflowExecutionFailureInfo) {
    const { namespace, workflowType, workflowExecution, retryState } = failure.childWorkflowExecutionFailureInfo;
    if (!(workflowType?.name && workflowExecution)) {
      throw new TypeError('Missing attributes on childWorkflowExecutionFailureInfo');
    }
    return new ChildWorkflowFailure(
      namespace ?? undefined,
      workflowExecution,
      workflowType.name,
      retryState ?? RetryState.RETRY_STATE_UNSPECIFIED,
      await optionalFailureToOptionalError(failure.cause, dataConverter)
    );
  }
  if (failure.activityFailureInfo) {
    if (!failure.activityFailureInfo.activityType?.name) {
      throw new TypeError('Missing activityType?.name on activityFailureInfo');
    }
    return new ActivityFailure(
      failure.activityFailureInfo.activityType.name,
      failure.activityFailureInfo.activityId ?? undefined,
      failure.activityFailureInfo.retryState ?? RetryState.RETRY_STATE_UNSPECIFIED,
      failure.activityFailureInfo.identity ?? undefined,
      await optionalFailureToOptionalError(failure.cause, dataConverter)
    );
  }
  return new TemporalFailure(
    failure.message ?? undefined,
    await optionalFailureToOptionalError(failure.cause, dataConverter)
  );
}

/**
 * Converts a Failure proto message to a JS Error object.
 */
export async function failureToError(failure: ProtoFailure, dataConverter: DataConverter): Promise<TemporalFailure> {
  const err = await failureToErrorInner(failure, dataConverter);
  err.stack = failure.stackTrace ?? '';
  err.failure = failure;
  return err;
}

/**
 * Get the root cause (string) of given error `err`.
 *
 * In case `err` is a {@link TemporalFailure}, recurse the cause chain and return the root's message.
 * Otherwise, return `err.message`.
 */
export function rootCause(err: unknown): string | undefined {
  if (err instanceof TemporalFailure) {
    return err.cause ? rootCause(err.cause) : err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  return undefined;
}
