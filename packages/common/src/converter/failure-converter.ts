import {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  ChildWorkflowFailure,
  FAILURE_SOURCE,
  ProtoFailure,
  RetryState,
  ServerFailure,
  TemporalFailure,
  TerminatedFailure,
  TimeoutFailure,
  TimeoutType,
} from '../failure';
import { hasOwnProperties, isRecord } from '../type-helpers';
import {
  arrayFromPayloads,
  defaultPayloadConverter,
  fromPayloadsAtIndex,
  PayloadConverter,
  toPayloads,
} from './payload-converter';

/**
 * Stack traces will be cutoff when on of these patterns is matched
 */
const CUTOFF_STACK_PATTERNS = [
  /** Activity execution */
  /\s+at Activity\.execute \(.*[\\/]worker[\\/](?:src|lib)[\\/]activity\.[jt]s:\d+:\d+\)/,
  /** Workflow activation */
  /\s+at Activator\.\S+NextHandler \(.*[\\/]workflow[\\/](?:src|lib)[\\/]internals\.[jt]s:\d+:\d+\)/,
  /** Workflow run anything in context */
  /\s+at Script\.runInContext \((?:node:vm|vm\.js):\d+:\d+\)/,
];

/**
 * Cuts out the framework part of a stack trace, leaving only user code entries
 */
export function cutoffStackTrace(stack?: string): string {
  const lines = (stack ?? '').split(/\r?\n/);
  const acc = Array<string>();
  lineLoop: for (const line of lines) {
    for (const pattern of CUTOFF_STACK_PATTERNS) {
      if (pattern.test(line)) break lineLoop;
    }
    acc.push(line);
  }
  return acc.join('\n');
}

/**
 * A `FailureConverter` is responsible to convert from proto `Failure` instances to JS `Errors` and back.
 *
 * It is recommended to use the {@link DefaultFailureConverter} and not attempt to customize the default implementation
 * in order to maintain cross language failure serialization compatibility.
 */
export interface FailureConverter {
  /**
   * Converts a caught error to a Failure proto message.
   */
  errorToFailure(err: unknown): ProtoFailure;
  /**
   * Converts a Failure proto message to a JS Error object.
   */
  failureToError(err: ProtoFailure): TemporalFailure;
}

/**
 * The "shape" of the attributes set as the {@link ProtoFailure.encodedAttributes} payload in case
 * {@link DefaultEncodedFailureAttributes.encodeCommonAttributes} is set to `true`.
 */
export interface DefaultEncodedFailureAttributes {
  message: string;
  stack_trace: string;
}

/**
 * Options for the {@link DefaultFailureConverter} constructor.
 */
export interface DefaultFailureConverterOptions {
  /**
   * The {@link PayloadConverter} to use for converting failure attributes.
   */
  payloadConverter: PayloadConverter;
  /**
   * Whether to encode error messages and stack traces (for encrypting these attributes use a {@link PayloadCodec}).
   */
  encodeCommonAttributes: boolean;
}

/**
 * Default cross language compatible failure converter.
 *
 * By default, it will leave error messages and stack traces as plain text. In order to encrypt those, set
 * `encodeCommonAttributes` to `true` in the constructor options and make sure to use a {@link PayloadCodec} that can
 * encrypt / decrypt payloads in your Worker and Client options.
 */
export class DefaultFailureConverter implements FailureConverter {
  public readonly options: DefaultFailureConverterOptions;

  constructor(options?: Partial<DefaultFailureConverterOptions>) {
    const { encodeCommonAttributes, payloadConverter } = options ?? {};
    this.options = {
      encodeCommonAttributes: encodeCommonAttributes ?? false,
      payloadConverter: payloadConverter ?? defaultPayloadConverter,
    };
  }

  /**
   * Converts a Failure proto message to a JS Error object.
   *
   * Does not set common properties, that is done in {@link failureToError}.
   */
  failureToErrorInner(failure: ProtoFailure): TemporalFailure {
    if (failure.applicationFailureInfo) {
      return new ApplicationFailure(
        failure.message ?? undefined,
        failure.applicationFailureInfo.type,
        Boolean(failure.applicationFailureInfo.nonRetryable),
        arrayFromPayloads(this.options.payloadConverter, failure.applicationFailureInfo.details?.payloads),
        this.optionalFailureToOptionalError(failure.cause)
      );
    }
    if (failure.serverFailureInfo) {
      return new ServerFailure(
        failure.message ?? undefined,
        Boolean(failure.serverFailureInfo.nonRetryable),
        this.optionalFailureToOptionalError(failure.cause)
      );
    }
    if (failure.timeoutFailureInfo) {
      return new TimeoutFailure(
        failure.message ?? undefined,
        fromPayloadsAtIndex(
          this.options.payloadConverter,
          0,
          failure.timeoutFailureInfo.lastHeartbeatDetails?.payloads
        ),
        failure.timeoutFailureInfo.timeoutType ?? TimeoutType.TIMEOUT_TYPE_UNSPECIFIED
      );
    }
    if (failure.terminatedFailureInfo) {
      return new TerminatedFailure(failure.message ?? undefined, this.optionalFailureToOptionalError(failure.cause));
    }
    if (failure.canceledFailureInfo) {
      return new CancelledFailure(
        failure.message ?? undefined,
        arrayFromPayloads(this.options.payloadConverter, failure.canceledFailureInfo.details?.payloads),
        this.optionalFailureToOptionalError(failure.cause)
      );
    }
    if (failure.resetWorkflowFailureInfo) {
      return new ApplicationFailure(
        failure.message ?? undefined,
        'ResetWorkflow',
        false,
        arrayFromPayloads(
          this.options.payloadConverter,
          failure.resetWorkflowFailureInfo.lastHeartbeatDetails?.payloads
        ),
        this.optionalFailureToOptionalError(failure.cause)
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
        this.optionalFailureToOptionalError(failure.cause)
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
        this.optionalFailureToOptionalError(failure.cause)
      );
    }
    return new TemporalFailure(failure.message ?? undefined, this.optionalFailureToOptionalError(failure.cause));
  }

  failureToError(failure: ProtoFailure): TemporalFailure {
    if (failure.encodedAttributes) {
      const attrs = this.options.payloadConverter.fromPayload<DefaultEncodedFailureAttributes>(
        failure.encodedAttributes
      );
      // Don't apply encodedAttributes unless they conform to an expected schema
      if (typeof attrs === 'object' && attrs !== null) {
        const { message, stack_trace } = attrs;
        // Avoid mutating the argument
        failure = { ...failure };
        if (typeof message === 'string') {
          failure.message = message;
        }
        if (typeof stack_trace === 'string') {
          failure.stackTrace = stack_trace;
        }
      }
    }
    const err = this.failureToErrorInner(failure);
    err.stack = failure.stackTrace ?? '';
    err.failure = failure;
    return err;
  }

  errorToFailure(err: unknown): ProtoFailure {
    const failure = this.errorToFailureInner(err);
    if (this.options.encodeCommonAttributes) {
      const { message, stackTrace } = failure;
      failure.message = 'Encoded failure';
      failure.stackTrace = '';
      failure.encodedAttributes = this.options.payloadConverter.toPayload({ message, stack_trace: stackTrace });
    }
    return failure;
  }

  errorToFailureInner(err: unknown): ProtoFailure {
    if (err instanceof TemporalFailure) {
      if (err.failure) return err.failure;
      const base = {
        message: err.message,
        stackTrace: cutoffStackTrace(err.stack),
        cause: this.optionalErrorToOptionalFailure(err.cause),
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
                ? { payloads: toPayloads(this.options.payloadConverter, ...err.details) }
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
                ? { payloads: toPayloads(this.options.payloadConverter, ...err.details) }
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
              ? { payloads: toPayloads(this.options.payloadConverter, err.lastHeartbeatDetails) }
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

    if (isRecord(err) && hasOwnProperties(err, ['message', 'stack'])) {
      return {
        ...base,
        message: String(err.message) ?? '',
        stackTrace: cutoffStackTrace(String(err.stack)),
        cause: this.optionalErrorToOptionalFailure(err.cause),
      };
    }

    const recommendation = ` [A non-Error value was thrown from your code. We recommend throwing Error objects so that we can provide a stack trace]`;

    if (typeof err === 'string') {
      return { ...base, message: err + recommendation };
    }
    if (typeof err === 'object') {
      let message = '';
      try {
        message = JSON.stringify(err);
      } catch (_err) {
        message = String(err);
      }
      return { ...base, message: message + recommendation };
    }

    return { ...base, message: String(err) + recommendation };
  }

  /**
   * Converts a Failure proto message to a JS Error object if defined or returns undefined.
   */
  optionalFailureToOptionalError(failure: ProtoFailure | undefined | null): TemporalFailure | undefined {
    return failure ? this.failureToError(failure) : undefined;
  }

  /**
   * Converts an error to a Failure proto message if defined or returns undefined
   */
  optionalErrorToOptionalFailure(err: unknown): ProtoFailure | undefined {
    return err ? this.errorToFailure(err) : undefined;
  }
}
